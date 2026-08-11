import { settlementTokens, tokenSimilarity } from '../normalize/canonical.js';
import type {
  DiffSeverity,
  SettlementDiff,
  SettlementFieldDiff,
  SettlementFieldKey,
  SettlementSpec,
} from '../domain/types.js';

/**
 * Settlement-rule diffing.
 *
 * Two markets can describe the same event and still pay out differently. A
 * confidence score alone hides that; this module produces a *readable,
 * specific* diff so the user can see the actual wording gap. That is a
 * product feature, not diagnostics.
 *
 * Everything here is deterministic string analysis. An LLM may be used
 * upstream to *propose* that two markets match, but the diff a user sees is
 * computed here, from the venues' own text.
 */

/**
 * Concepts whose value materially changes who gets paid. Each concept
 * enumerates mutually contradictory variants; if two texts assert different
 * variants of the same concept, the settlement rules genuinely disagree.
 */
interface Concept {
  key: string;
  label: string;
  /** Contradictory variants. Order is irrelevant. */
  variants: Array<{ id: string; describe: string; patterns: RegExp[] }>;
  /** A disagreement on this concept can never be waved through. */
  disqualifying: boolean;
}

const CONCEPTS: Concept[] = [
  {
    key: 'overtime',
    label: 'Overtime treatment',
    disqualifying: true,
    variants: [
      {
        id: 'INCLUDES_OT',
        describe: 'settles on the result including overtime',
        patterns: [
          /includ\w*\s+(?:any\s+)?(?:overtime|ot|extra time|extra innings|shootout)/i,
          /(?:overtime|extra time|extra innings|shootout)s?\s+(?:will\s+)?count/i,
          /final score.{0,30}includ\w*\s+overtime/i,
        ],
      },
      {
        id: 'EXCLUDES_OT',
        describe: 'settles on regulation time only',
        patterns: [
          /(?:excluding|not includ\w*|without)\s+(?:any\s+)?(?:overtime|ot|extra time|extra innings|shootout)/i,
          /regulation (?:time|play) only/i,
          /end of regulation/i,
          /(?:overtime|extra time)s?\s+(?:does|do|will) not count/i,
        ],
      },
    ],
  },
  {
    key: 'void',
    label: 'Void / cancellation handling',
    disqualifying: false,
    variants: [
      {
        id: 'VOID_REFUND',
        describe: 'voids and refunds stakes',
        patterns: [/void/i, /refund\w*/i, /no action/i, /stakes? (?:are )?returned/i],
      },
      {
        id: 'RESOLVE_NO',
        describe: 'resolves NO rather than voiding',
        patterns: [
          /resolve\w*\s+(?:to\s+)?(?:"?no"?|negative)/i,
          /settle\w*\s+(?:to\s+)?(?:"?no"?)/i,
          /will not void/i,
        ],
      },
      {
        id: 'POSTPONE_CARRY',
        describe: 'carries over if postponed',
        patterns: [/postpon\w*/i, /reschedul\w*/i, /suspend\w*/i, /carr(?:y|ies|ied) over/i],
      },
    ],
  },
  {
    key: 'timing',
    label: 'Settlement timing',
    disqualifying: false,
    variants: [
      {
        id: 'CERTIFIED',
        describe: 'waits for a certified / official final result',
        patterns: [/certif\w+/i, /official(?:ly)? (?:declared|announced|final)/i, /inaugurat\w+/i],
      },
      {
        id: 'PROJECTED',
        describe: 'settles on a projection or call, before certification',
        patterns: [/project\w+/i, /\bcall(?:ed|s)?\b/i, /declar\w+ (?:the )?winner/i, /consensus/i],
      },
      {
        id: 'AT_EXPIRY',
        describe: 'settles at a fixed expiration timestamp',
        patterns: [/at (?:the )?(?:expiration|expiry|close)/i, /as of \d/i, /\bet\b.{0,12}\d/i],
      },
    ],
  },
  {
    key: 'threshold_direction',
    label: 'Threshold direction',
    disqualifying: true,
    variants: [
      {
        id: 'AT_OR_ABOVE',
        describe: 'pays at or above the threshold',
        patterns: [/at or above/i, /greater than or equal/i, /\bor more\b/i, /\bat least\b/i],
      },
      {
        id: 'STRICTLY_ABOVE',
        describe: 'pays strictly above the threshold',
        patterns: [/(?:strictly )?(?:greater|more|higher) than(?! or equal)/i, /\babove\b(?! or)/i],
      },
      {
        id: 'BELOW',
        describe: 'pays below the threshold',
        patterns: [/(?:less|lower|fewer) than/i, /\bbelow\b/i, /at or below/i],
      },
    ],
  },
];

const FIELD_LABELS: Record<SettlementFieldKey, string> = {
  settlement_source: 'Settlement source',
  settlement_rules_text: 'Settlement rules',
  void_rules: 'Void rules',
  overtime_rules: 'Overtime rules',
};

/** Severity ordering, worst last. */
const SEVERITY_RANK: Record<DiffSeverity, number> = {
  IDENTICAL: 0,
  COSMETIC: 1,
  MATERIAL: 2,
  DISQUALIFYING: 3,
};

const PENALTY: Record<DiffSeverity, number> = {
  IDENTICAL: 0,
  COSMETIC: 0.02,
  MATERIAL: 0.09,
  // Forces the match below any usable threshold on its own.
  DISQUALIFYING: 1,
};

/**
 * A material difference costs more when both venues actually documented the
 * rule and the two statements disagree.
 *
 * Silence leaves an unknown that might resolve either way. A stated conflict —
 * one venue settling a $100,000 threshold on one price index and the other on
 * a different index — is a known difference, and it is exactly the kind that
 * bites at a threshold, where two indices that agree to four decimal places
 * most of the time can still land on opposite sides.
 */
const MATERIAL_CONFLICT_PENALTY = 0.15;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function detectVariants(concept: Concept, text: string): Set<string> {
  const found = new Set<string>();
  for (const variant of concept.variants) {
    if (variant.patterns.some((p) => p.test(text))) found.add(variant.id);
  }
  return found;
}

interface ConceptConflict {
  concept: Concept;
  leftVariants: string[];
  rightVariants: string[];
}

function conceptConflicts(left: string, right: string): ConceptConflict[] {
  const conflicts: ConceptConflict[] = [];
  for (const concept of CONCEPTS) {
    const l = detectVariants(concept, left);
    const r = detectVariants(concept, right);
    if (l.size === 0 || r.size === 0) continue;
    // Only a conflict if neither side asserts anything the other does.
    const shared = [...l].some((v) => r.has(v));
    if (!shared) {
      conflicts.push({ concept, leftVariants: [...l], rightVariants: [...r] });
    }
  }
  return conflicts;
}

function describeVariants(concept: Concept, ids: string[]): string {
  const described = ids
    .map((id) => concept.variants.find((v) => v.id === id)?.describe ?? id)
    .join(' / ');
  return described.length > 0 ? described : 'unspecified';
}

/** Significant tokens present on one side only, for the wording-gap display. */
function exclusiveTerms(from: string[], other: string[], limit = 12): string[] {
  const otherSet = new Set(other);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of from) {
    if (otherSet.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

export function diffSettlementField(
  field: SettlementFieldKey,
  leftRaw: string,
  rightRaw: string,
): SettlementFieldDiff {
  const left = normalizeWhitespace(leftRaw);
  const right = normalizeWhitespace(rightRaw);
  const label = FIELD_LABELS[field];

  const leftTokens = settlementTokens(left);
  const rightTokens = settlementTokens(right);
  const similarity = tokenSimilarity(leftTokens, rightTokens);

  const bothDocumented = left !== '' && right !== '';
  const base: Omit<SettlementFieldDiff, 'severity' | 'explanation'> = {
    field,
    label,
    left,
    right,
    left_only_terms: exclusiveTerms(leftTokens, rightTokens),
    right_only_terms: exclusiveTerms(rightTokens, leftTokens),
    conflict: false,
  };

  if (left.toLowerCase() === right.toLowerCase()) {
    return { ...base, severity: 'IDENTICAL', explanation: 'Both venues use identical wording.' };
  }

  // One side documents a rule the other is silent on. Silence is not
  // agreement — it is an unknown, and unknowns are material.
  if (left === '' || right === '') {
    const missing = left === '' ? 'left' : 'right';
    const present = missing === 'left' ? right : left;
    return {
      ...base,
      severity: 'MATERIAL',
      explanation:
        `Only one venue documents this rule. The other is silent, so the rules cannot be ` +
        `confirmed equivalent. Documented text: "${truncate(present, 160)}"`,
    };
  }

  const conflicts = conceptConflicts(left, right);
  if (conflicts.length > 0) {
    const disqualifying = conflicts.some((c) => c.concept.disqualifying);
    const explanation = conflicts
      .map(
        (c) =>
          `${c.concept.label}: this venue ${describeVariants(c.concept, c.leftVariants)}, ` +
          `the other ${describeVariants(c.concept, c.rightVariants)}.`,
      )
      .join(' ');
    return {
      ...base,
      severity: disqualifying ? 'DISQUALIFYING' : 'MATERIAL',
      conflict: bothDocumented,
      explanation,
    };
  }

  if (similarity >= 0.85) {
    return {
      ...base,
      severity: 'COSMETIC',
      explanation:
        `Wording differs but no rule-bearing term conflicts ` +
        `(${Math.round(similarity * 100)}% term overlap).`,
    };
  }

  return {
    ...base,
    severity: 'MATERIAL',
    conflict: bothDocumented,
    explanation:
      (bothDocumented
        ? 'Both venues document this rule and the statements disagree. '
        : '') +
      `Rules share only ${Math.round(similarity * 100)}% of their terms. ` +
      `Unmatched on this side: ${base.left_only_terms.slice(0, 6).join(', ') || 'none'}. ` +
      `Unmatched on the other: ${base.right_only_terms.slice(0, 6).join(', ') || 'none'}.`,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const FIELDS: SettlementFieldKey[] = [
  'settlement_source',
  'settlement_rules_text',
  'void_rules',
  'overtime_rules',
];

export function diffSettlement(left: SettlementSpec, right: SettlementSpec): SettlementDiff {
  const fields = FIELDS.map((field) => diffSettlementField(field, left[field], right[field]));

  const worst = fields.reduce<DiffSeverity>(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    'IDENTICAL',
  );

  // Penalties accumulate, but a single disqualifying field dominates.
  const penalty = fields.some((f) => f.severity === 'DISQUALIFYING')
    ? 1
    : Math.min(
        0.45,
        fields.reduce(
          (sum, f) =>
            sum +
            (f.severity === 'MATERIAL' && f.conflict
              ? MATERIAL_CONFLICT_PENALTY
              : PENALTY[f.severity]),
          0,
        ),
      );

  const problems = fields.filter((f) => f.severity !== 'IDENTICAL');
  const conflicts = problems.filter((f) => f.conflict);
  const summary =
    problems.length === 0
      ? 'Settlement rules are identical across venues.'
      : `${problems.length} of ${fields.length} settlement fields differ ` +
        `(worst: ${worst.toLowerCase()}): ${problems.map((p) => p.label).join(', ')}.` +
        (conflicts.length > 0
          ? ` ${conflicts.length} are stated conflicts rather than undocumented rules.`
          : '');

  return { fields, worst_severity: worst, confidence_penalty: penalty, summary };
}

/** Diff for a single-venue opportunity: every leg shares one rule set. */
export function identicalSettlement(): SettlementDiff {
  return {
    fields: [],
    worst_severity: 'IDENTICAL',
    confidence_penalty: 0,
    summary: 'All legs settle under one venue rule set; no cross-venue settlement risk.',
  };
}
