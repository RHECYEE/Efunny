/**
 * Fighter attributes, and where each one came from.
 *
 * This file exists to answer two questions a price cannot: where a fighter is
 * from, and whether they win by grappling or by striking. Neither is in any
 * market feed, and neither may be guessed. A confidently wrong "BJJ black
 * belt" is worse than an honest blank, because a blank prompts a check and a
 * fabrication does not — so every field here is either sourced or absent, and
 * the source travels with it.
 *
 * Two sources, chosen for being citable rather than convenient:
 *   - UFC.com's own athlete bios, for the fighting style the promotion itself
 *     lists.
 *   - Wikidata, for country of citizenship, which is structured and has far
 *     better coverage than any fight-stats site.
 */

export type StyleClass = 'GRAPPLER' | 'STRIKER' | 'UNKNOWN';

export interface Fighter {
  name: string;
  /** Normalized name key, order-independent. */
  key: string;
  nationality: string | null;
  nationality_source: string | null;
  /** The style label exactly as the source words it. */
  style_label: string | null;
  style_source: string | null;
  style_class: StyleClass;
  nickname: string | null;
  record: string | null;
}

/**
 * Styles that describe how a fighter finishes.
 *
 * The buckets are the promotion's own vocabulary, sorted once here rather
 * than inferred per fighter. "MMA" and "Freestyle" are deliberately in
 * neither: they are what the bio says when it says nothing, and forcing them
 * into a bucket would invent a read on roughly half the roster.
 */
const GRAPPLING_STYLES = new Set([
  'jiu-jitsu',
  'brazilian jiu-jitsu',
  'bjj',
  'wrestling',
  'wrestler',
  'judo',
  'sambo',
  'grappler',
  'submission',
]);

const STRIKING_STYLES = new Set([
  'striker',
  'muay thai',
  'kickboxer',
  'kickboxing',
  'karate',
  'boxer',
  'boxing',
  'kung fu',
  'taekwondo',
  'brawler',
  'sanda',
]);

export function classifyStyle(label: string | null | undefined): StyleClass {
  const key = (label ?? '').trim().toLowerCase();
  if (key === '') return 'UNKNOWN';
  if (GRAPPLING_STYLES.has(key)) return 'GRAPPLER';
  if (STRIKING_STYLES.has(key)) return 'STRIKER';
  return 'UNKNOWN';
}

/**
 * Name key that survives the venues disagreeing about word order.
 *
 * Kalshi lists "Yadong Song" and Polymarket lists "Song Yadong". Sorting the
 * tokens makes those one key without any per-name special casing, and without
 * fuzzy matching that could quietly merge two different people.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .sort()
    .join(' ');
}

/** Country names that count as Brazilian for the filter. */
const BRAZIL = /brazil/i;

export function isBrazilian(fighter: Fighter): boolean {
  return BRAZIL.test(fighter.nationality ?? '');
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

export interface DossierSourceOptions {
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
  /** Skip Wikidata, e.g. when offline. Style-only dossiers still work. */
  skip_nationality?: boolean;
}

interface OctagonFighter {
  name?: string;
  nickname?: string;
  wins?: string;
  losses?: string;
  draws?: string;
  placeOfBirth?: string;
  fightingStyle?: string;
}

const OCTAGON_URL = 'https://api.octagon-api.com/fighters';
const WIKIDATA_URL = 'https://query.wikidata.org/sparql';

/**
 * Every MMA fighter Wikidata knows, with country of citizenship.
 *
 * Q11607585 is "mixed martial arts fighter", and getting that identifier
 * right is load-bearing rather than incidental. A neighbouring class returns
 * a comparable-looking 16,000 people, which is what makes the mistake so
 * quiet: the query succeeds, the counts look healthy, and the set is mostly
 * boxers. Every fighter on a real card came back "not in dossier" while the
 * dossier reported itself full.
 *
 * The query is deliberately not narrowed to a promotion — that would drop
 * exactly the lower-card fighters the market feeds are full of.
 */
const NATIONALITY_QUERY = `
SELECT ?person ?personLabel ?countryLabel WHERE {
  ?person wdt:P106 wd:Q11607585 ; wdt:P27 ?country .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

/**
 * Run a SPARQL query in pages.
 *
 * A single unpaged query for every MMA fighter comes back *short* rather than
 * failing — the endpoint hits its time budget, returns what it has, and says
 * nothing about the rest. That silence is the dangerous part: it looked like
 * 14,692 complete records when the real count was 16,334, and the missing
 * tenth was not random. It was the low-profile fighters who fill a
 * preliminary card, which is exactly who a scan of tomorrow's fights needs to
 * look up.
 *
 * Ordering by the entity itself keeps the pages stable and lets the endpoint
 * walk an index instead of sorting the whole result set.
 */
async function pagedQuery<T>(
  body: string,
  options: DossierSourceOptions,
  onRow: (row: T) => void,
  pageSize = 5_000,
): Promise<void> {
  const doFetch = options.fetch_impl ?? fetch;
  for (let offset = 0; ; offset += pageSize) {
    const query = `${body}\nORDER BY ?person\nLIMIT ${pageSize} OFFSET ${offset}`;
    const response = await doFetch(`${WIKIDATA_URL}?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(options.request_timeout_ms ?? 90_000),
      headers: { accept: 'application/sparql-results+json', 'user-agent': 'ArbTerminal/0.1' },
    });
    if (!response.ok) throw new Error(`Wikidata ${response.status}`);
    const parsed = (await response.json()) as { results?: { bindings?: T[] } };
    const rows = parsed.results?.bindings ?? [];
    for (const row of rows) onRow(row);
    if (rows.length < pageSize) return;
  }
}

export async function fetchStyles(
  options: DossierSourceOptions = {},
): Promise<Map<string, { label: string | null; nickname: string | null; record: string | null; birthplace: string | null }>> {
  const doFetch = options.fetch_impl ?? fetch;
  const response = await doFetch(OCTAGON_URL, {
    signal: AbortSignal.timeout(options.request_timeout_ms ?? 30_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`UFC athlete bios ${response.status}`);
  const body = (await response.json()) as Record<string, OctagonFighter>;

  const out = new Map<string, { label: string | null; nickname: string | null; record: string | null; birthplace: string | null }>();
  for (const entry of Object.values(body ?? {})) {
    const name = (entry.name ?? '').trim();
    if (name === '') continue;
    const record =
      entry.wins !== undefined ? `${entry.wins}-${entry.losses ?? '?'}-${entry.draws ?? '0'}` : null;
    out.set(nameKey(name), {
      label: (entry.fightingStyle ?? '').trim() || null,
      nickname: (entry.nickname ?? '').trim() || null,
      record,
      birthplace: (entry.placeOfBirth ?? '').trim() || null,
    });
  }
  return out;
}

/**
 * Background disciplines, which are the fallback style signal.
 *
 * The promotion labels only a few hundred fighters and calls half of those
 * "MMA". Wikidata records what a fighter *did before* — judo, wrestling,
 * boxing, muay thai — for far more of them, and a career discipline is a
 * better read on how someone fights than a blank.
 *
 * It is a weaker claim than the promotion's own label and is recorded as
 * such, because a boxing background is evidence about a striker rather than
 * a statement that they are one.
 */
const DISCIPLINE_QUERY = `
SELECT ?person ?personLabel ?occLabel ?sportLabel WHERE {
  ?person wdt:P106 wd:Q11607585 .
  OPTIONAL { ?person wdt:P106 ?occ }
  OPTIONAL { ?person wdt:P641 ?sport }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

/**
 * Discipline terms, mapped to how somebody fights.
 *
 * "Professional wrestler" is deliberately absent. It means WWE, not amateur
 * wrestling, and reading it as a grappling background would classify
 * entertainers as takedown threats.
 */
const DISCIPLINE_CLASS: Array<[RegExp, StyleClass]> = [
  [/^(judoka|judo)$/i, 'GRAPPLER'],
  [/\b(sambo|sambist)\b/i, 'GRAPPLER'],
  [/\bjiu[- ]?jitsu\b|\bjujutsu\b|\bgrappling\b/i, 'GRAPPLER'],
  // "sport wrestler" / "amateur wrestling" only — never "professional".
  [/^(sport wrestler|amateur wrestler|wrestling|freestyle wrestling|greco-roman wrestling)$/i, 'GRAPPLER'],
  [/^(boxer|boxing|thai boxer|kickboxer|kickboxing|karateka|karate)$/i, 'STRIKER'],
  [/\bmuay thai\b|\bk-1\b|\btaekwondo\b|\bsanda\b|\bsavate\b/i, 'STRIKER'],
];

export function classifyDiscipline(term: string): StyleClass {
  for (const [pattern, cls] of DISCIPLINE_CLASS) {
    if (pattern.test(term.trim())) return cls;
  }
  return 'UNKNOWN';
}

export async function fetchDisciplines(
  options: DossierSourceOptions = {},
): Promise<Map<string, { cls: StyleClass; term: string }>> {
  const out = new Map<string, { cls: StyleClass; term: string }>();
  await pagedQuery<{
    personLabel?: { value?: string };
    occLabel?: { value?: string };
    sportLabel?: { value?: string };
  }>(DISCIPLINE_QUERY, options, (row) => {
    const name = row.personLabel?.value?.trim();
    if (!name || /^Q\d+$/.test(name)) return;
    const key = nameKey(name);
    if (key === '' || out.has(key)) return;

    for (const term of [row.occLabel?.value, row.sportLabel?.value]) {
      if (!term) continue;
      const cls = classifyDiscipline(term);
      if (cls !== 'UNKNOWN') {
        out.set(key, { cls, term });
        break;
      }
    }
  });
  return out;
}

export async function fetchNationalities(
  options: DossierSourceOptions = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await pagedQuery<{ personLabel?: { value?: string }; countryLabel?: { value?: string } }>(
    NATIONALITY_QUERY,
    options,
    (row) => {
      const name = row.personLabel?.value?.trim();
      const country = row.countryLabel?.value?.trim();
      // A label that is still a Q-number means Wikidata has no English name.
      if (!name || !country || /^Q\d+$/.test(name)) return;
      const key = nameKey(name);
      if (key !== '' && !out.has(key)) out.set(key, country);
    },
  );
  return out;
}

/**
 * Build the dossier from both sources.
 *
 * Nationality prefers Wikidata's citizenship over the bio's place of birth:
 * they usually agree, and where they do not, citizenship is the claim being
 * made. Place of birth fills the gap when Wikidata has never heard of the
 * fighter, which on a preliminary card is often.
 */
export async function buildDossier(options: DossierSourceOptions = {}): Promise<Map<string, Fighter>> {
  const [styles, nationalities, disciplines] = await Promise.all([
    fetchStyles(options).catch(() => new Map()),
    options.skip_nationality
      ? Promise.resolve(new Map<string, string>())
      : fetchNationalities(options).catch(() => new Map<string, string>()),
    options.skip_nationality
      ? Promise.resolve(new Map<string, { cls: StyleClass; term: string }>())
      : fetchDisciplines(options).catch(() => new Map<string, { cls: StyleClass; term: string }>()),
  ]);

  const keys = new Set<string>([
    ...styles.keys(),
    ...nationalities.keys(),
    ...disciplines.keys(),
  ]);
  const out = new Map<string, Fighter>();

  for (const key of keys) {
    const style = styles.get(key);
    const citizenship = nationalities.get(key) ?? null;
    const birthplace = style?.birthplace ?? null;

    const nationality = citizenship ?? (birthplace ? birthplace.split(',').pop()!.trim() : null);
    const nationalitySource = citizenship
      ? 'Wikidata: country of citizenship'
      : birthplace
        ? 'UFC.com athlete bio: place of birth'
        : null;

    // The promotion's own label wins where it says something. It is a
    // statement about how this fighter fights now; a background discipline
    // is an inference from what they did before, and only stands in when
    // there is nothing better.
    const promoted = classifyStyle(style?.label);
    const background = disciplines.get(key) ?? null;
    const usingBackground = promoted === 'UNKNOWN' && background !== null;

    out.set(key, {
      name: key,
      key,
      nationality,
      nationality_source: nationalitySource,
      style_label: usingBackground ? background!.term : (style?.label ?? null),
      style_source: usingBackground
        ? `Wikidata: background discipline (${background!.term})`
        : style?.label
          ? 'UFC.com athlete bio: fighting style'
          : null,
      style_class: usingBackground ? background!.cls : promoted,
      nickname: style?.nickname ?? null,
      record: style?.record ?? null,
    });
  }

  return out;
}

export function lookup(dossier: Map<string, Fighter>, name: string): Fighter | null {
  return dossier.get(nameKey(name)) ?? null;
}
