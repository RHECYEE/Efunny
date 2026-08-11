import type { MarketMatch, SettlementDiff, SettlementFieldDiff } from '@arbterminal/core';

interface Props {
  diff: SettlementDiff | null;
  matches: MarketMatch[];
}

const MARK: Record<SettlementFieldDiff['severity'], string> = {
  IDENTICAL: '✓',
  COSMETIC: '≈',
  MATERIAL: '!',
  DISQUALIFYING: '✕',
};

/**
 * The settlement comparison.
 *
 * A confidence score alone hides *why* two contracts might not pay out
 * together, so this shows the venues' own wording side by side with the
 * specific terms that appear on only one side highlighted. This is the
 * feature that turns "95% match" into something a user can actually check.
 */
export function SettlementChecklist({ diff, matches }: Props) {
  if (!diff) {
    return (
      <div className="panel">
        <h3>Settlement comparison</h3>
        <div className="muted">No settlement comparison applies to a single-venue position.</div>
      </div>
    );
  }

  const checks = matches[0]?.checks ?? [];

  return (
    <div className="panel">
      <h3>Settlement comparison</h3>

      <div className={`sev-${diff.worst_severity}`} style={{ marginBottom: 7 }}>
        {diff.summary}
      </div>

      {checks.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {checks.map((check) => (
            <div className="check-item" key={check.name}>
              <span className={`mark ${check.passed ? 'pos' : check.blocking ? 'neg' : 'warn'}`}>
                {check.passed ? '✓' : check.blocking ? '✕' : '!'}
              </span>
              <div>
                <div>{check.name.replace(/_/g, ' ')}</div>
                <div className="why">{check.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {diff.fields.length > 0 && (
        <>
          {diff.fields.map((field) => (
            <div className="check-item" key={field.field}>
              <span className={`mark sev-${field.severity}`}>{MARK[field.severity]}</span>
              <div>
                <div className="row between">
                  <span>{field.label}</span>
                  <span className={`sev-${field.severity}`} style={{ fontSize: 10 }}>
                    {field.severity}
                  </span>
                </div>
                <div className="why">{field.explanation}</div>
              </div>
            </div>
          ))}

          <details className="diff">
            <summary>▸ Read settlement differences</summary>
            <div className="diff-body">
              {diff.fields
                .filter((field) => field.severity !== 'IDENTICAL')
                .map((field) => (
                  <div className="diff-field" key={field.field}>
                    <div className="row between">
                      <strong>{field.label}</strong>
                      <span className={`sev-${field.severity}`}>{field.severity}</span>
                    </div>
                    <div className="why" style={{ marginTop: 2 }}>
                      {field.explanation}
                    </div>

                    <div className="diff-side left">
                      {field.left || <span className="dim">(not documented)</span>}
                    </div>
                    <div className="diff-side right">
                      {field.right || <span className="dim">(not documented)</span>}
                    </div>

                    {(field.left_only_terms.length > 0 || field.right_only_terms.length > 0) && (
                      <div style={{ marginTop: 5 }}>
                        <div className="dim" style={{ fontSize: 10 }}>
                          terms on one side only
                        </div>
                        <div style={{ marginTop: 2 }}>
                          {field.left_only_terms.map((term) => (
                            <span className="term" key={`l-${term}`}>
                              ◂ {term}
                            </span>
                          ))}
                          {field.right_only_terms.map((term) => (
                            <span className="term" key={`r-${term}`}>
                              ▸ {term}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

              {diff.fields.every((f) => f.severity === 'IDENTICAL') && (
                <div className="muted">Every settlement field matches word for word.</div>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
