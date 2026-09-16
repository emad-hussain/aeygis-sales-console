import { useMemo, useState } from 'react';
import { canQuote, quote, type QuoteResult, type SupportPlan, type Tier } from '@aeygis/pricing';
import { generateProposal } from './client';

const cad = (n: number) => '$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 });

interface Props {
  readonly assessmentId: string;
  readonly providerCount: number | null;
  readonly locationCount: number | null;
  readonly patientCount: number | null;
  readonly countsConfirmed: boolean;
  readonly canGenerate: boolean;
  /** Called after a version is created so the approval panel can refresh. */
  readonly onProposalGenerated: () => void;
}

/**
 * Live quote for the meeting.
 *
 * Three behaviours here are deliberate and must not be "helpfully" relaxed:
 *
 *  1. It refuses to price until exact counts are confirmed. The public form
 *     supplies bands, and a band spans more than one tier.
 *  2. Enterprise shows NO price. The engine returns a refusal branch with no
 *     price fields; this renders that refusal rather than filling in the guide
 *     range as if it were a quote.
 *  3. When Micro and Starter both apply, BOTH are shown side by side. The
 *     approved docs resolve that overlap by human judgement, so the tool
 *     presents the choice instead of making it.
 */
export function PricingPanel({
  assessmentId,
  providerCount,
  locationCount,
  patientCount,
  countsConfirmed,
  canGenerate,
  onProposalGenerated,
}: Props) {
  const [priceFactorPct, setPriceFactorPct] = useState(100);
  const [planFilter, setPlanFilter] = useState<SupportPlan | ''>('');
  const [generating, setGenerating] = useState<Tier | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [genNotice, setGenNotice] = useState<string | null>(null);

  async function generate(tier: Tier, plan: SupportPlan) {
    setGenerating(tier);
    setGenError(null);
    setGenNotice(null);
    try {
      const result = await generateProposal({
        assessmentId,
        tier,
        supportPlan: plan,
        priceFactor: priceFactorPct / 100,
      });
      if (result?.ok) {
        setGenNotice(
          `Created ${result.proposalId} ${result.versionKey}. It is immutable — to change it, ` +
            'generate a new version. Approve it in the Approval panel below.',
        );
        onProposalGenerated();
      } else {
        setGenError(result?.message ?? 'Could not create the proposal version.');
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Could not create the proposal version');
    } finally {
      setGenerating(null);
    }
  }

  const gate = canQuote({ providerCount, locationCount, countsConfirmed });

  const result = useMemo<QuoteResult | null>(() => {
    if (!gate.ok || providerCount === null || locationCount === null) return null;
    try {
      return quote({
        providers: providerCount,
        locations: locationCount,
        patients: patientCount ?? undefined,
        priceFactor: priceFactorPct / 100,
        supportPlan: planFilter === '' ? undefined : planFilter,
      });
    } catch (error) {
      return null;
    }
  }, [gate.ok, providerCount, locationCount, patientCount, priceFactorPct, planFilter]);

  if (!gate.ok) {
    return (
      <>
        <div className="panel-head">
          <h2>Pricing</h2>
          <span className="note">blocked &middot; exact counts required</span>
        </div>
        <div className="panel-body">
          <div className="notice notice-block">{gate.reason}</div>
          <p className="hint flush">
            Enter exact provider and location counts in <strong>Scope</strong> above and tick “counts
            confirmed”. The public form collects ranges, and a range like “3&ndash;15 providers”
            covers both Professional and Enterprise &mdash; a difference of hundreds of thousands of
            dollars.
          </p>
        </div>
      </>
    );
  }

  if (result === null) {
    return (
      <>
        <div className="panel-head">
          <h2>Pricing</h2>
        </div>
        <div className="panel-body">
          <p className="muted flush">
            No quote available for these inputs.
          </p>
        </div>
      </>
    );
  }

  if (result.kind === 'requires-discovery-call') {
    return (
      <>
        <div className="panel-head">
          <h2>Pricing &mdash; Enterprise</h2>
          <span className="note">discovery call required</span>
        </div>
        <div className="panel-body">
          <div className="notice notice-warn">{result.reason}</div>
          <p className="tiny muted">
            <strong>Internal guidance only, never quote this to a client:</strong>{' '}
            <span className="mono">
              {result.internalGuideRange
                ? `${cad(result.internalGuideRange.min.amount)}–${cad(result.internalGuideRange.max.amount)}+ setup`
                : 'no range available'}
            </span>
            .
          </p>
          <details>
            <summary className="tiny muted">Why Enterprise?</summary>
            <ul className="tiny muted">
              {result.rationale.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </details>
        </div>
      </>
    );
  }

  const { options, discount } = result;

  return (
    <>
      <div className="panel-head">
        <h2>
          Pricing &mdash; {options.length > 1 ? 'two tiers apply' : (options[0]?.tierLabel ?? '')}
        </h2>
        <span className="note">price book {result.priceBookVersion}</span>
      </div>
      <div className="panel-body">
      {options.length > 1 && (
        <div className="notice notice-info">
          This clinic matches <strong>both</strong> {options.map((o) => o.tierLabel).join(' and ')}. The Rate
          Card resolves this by judgement: “only offer Micro to a genuinely tiny, one-provider clinic”, and
          lead with Starter for a real 1&ndash;2 provider clinic.
        </div>
      )}

      <div className="field-row price-controls">
        <div className="field">
          <label htmlFor="pf">Price as % of list</label>
          <input
            id="pf"
            type="number"
            min={1}
            max={100}
            value={priceFactorPct}
            onChange={(e) => setPriceFactorPct(Math.max(1, Math.min(100, Number(e.target.value) || 0)))}
          />
        </div>
        <div className="field">
          <label htmlFor="plan">Show plan</label>
          <select
            id="plan"
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value as SupportPlan | '')}
          >
            <option value="">All eligible plans</option>
            <option value="trainAndWalkAway">Train &amp; Walk Away</option>
            <option value="essentials">Essentials</option>
            <option value="fullManaged">Full Managed</option>
          </select>
        </div>
      </div>

      {genError && <div className="notice notice-block">{genError}</div>}
      {genNotice && <div className="notice notice-info">{genNotice}</div>}

      {discount.requiresExecutiveSignOff && (
        <div className="notice notice-block">
          <strong>Executive sign-off required.</strong> {discount.note}
        </div>
      )}

      {options.map((option) => (
        <div className="price-block" key={option.tier}>
          <h3>
            {option.tierLabel}
            <span className="price-setup">
              setup {cad(option.setup.quotedTotal.amount)}
              {option.setup.quotedTotal.amount !== option.setup.listTotal.amount && (
                <> (list {cad(option.setup.listTotal.amount)})</>
              )}
            </span>
          </h3>

          {(option.setup.extraProviders.count > 0 || option.setup.extraLocations.count > 0) && (
            <p className="price-breakdown">
              {cad(option.setup.base.amount)} base
              {option.setup.extraProviders.count > 0 && (
                <>
                  {' '}
                  + {option.setup.extraProviders.count} &times; {cad(option.setup.extraProviders.unit.amount)}{' '}
                  provider
                </>
              )}
              {option.setup.extraLocations.count > 0 && (
                <>
                  {' '}
                  + {option.setup.extraLocations.count} &times; {cad(option.setup.extraLocations.unit.amount)}{' '}
                  location
                </>
              )}
            </p>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Support plan</th>
                  <th className="num">Monthly</th>
                  <th className="num">Annual check-up</th>
                  <th className="num">Year 1 total</th>
                  {canGenerate && <th />}
                </tr>
              </thead>
              <tbody>
                {option.plans.map((p) => (
                  <tr key={p.plan}>
                    <td>
                      {p.planLabel}
                      {p.customQuote && <span className="tiny muted"> (starting point)</span>}
                    </td>
                    <td className="num">{cad(p.monthlyQuotedTotal.amount)}</td>
                    <td className="num">
                      {p.annualCheckup.amount > 0 ? (
                        <span title="Mandatory. Never discounted.">{cad(p.annualCheckup.amount)}</span>
                      ) : (
                        <span className="muted">&mdash;</span>
                      )}
                    </td>
                    <td className="num">
                      <strong>{cad(p.firstYearQuotedTotal.amount)}</strong>
                    </td>
                    {canGenerate && (
                      <td>
                        <button
                          className="secondary"
                          disabled={generating !== null}
                          onClick={() => void generate(option.tier, p.plan)}
                          title={`Create an immutable proposal version for ${option.tierLabel} / ${p.planLabel}`}
                        >
                          {generating === option.tier ? 'Creating…' : 'Generate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {option.ineligiblePlans.map((p) => (
                  <tr key={p.plan}>
                    <td className="muted">{p.planLabel}</td>
                    <td colSpan={canGenerate ? 4 : 3} className="tiny muted">
                      <strong>Not offered.</strong> {p.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <details>
        <summary className="tiny muted">Client always pays these separately</summary>
        <ul className="tiny muted">
          {result.clientPaysSeparately.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </details>
      </div>
    </>
  );
}
