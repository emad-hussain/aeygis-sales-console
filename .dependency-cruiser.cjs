/**
 * Confidentiality boundary enforcement.
 *
 * `@aeygis/pricing-internal` holds internal delivery cost per hour, margin
 * reasoning, and competitor analysis, sourced from Aeygis_Cloud_Rate_Card.pdf
 * which is marked "CONFIDENTIAL — Internal Use Only".
 *
 * The PDF renderer produces a CLIENT-FACING document. If it can import that
 * package — directly or through any chain of intermediate modules — then a
 * future one-line change can leak Aeygis margin data to a prospect. An
 * authorization rule cannot prevent this, because the leak happens inside a
 * single Lambda's own process.
 *
 * This is barrier 1 of 5. See the plan's architecture notes for the others.
 * A failure here is a confidentiality incident, not a lint nit.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-internal-pricing-in-renderer',
      severity: 'error',
      comment:
        'The client-facing PDF renderer must never reach internal cost/margin data, ' +
        'even transitively.',
      from: { path: '^amplify/functions/render-proposal-pdf' },
      to: { path: '^packages/pricing-internal' },
    },
    {
      name: 'no-internal-pricing-in-email-sender',
      severity: 'error',
      comment:
        'The proposal email is client-facing in two ways at once: the body it composes ' +
        'and the PDF it attaches both land in a prospect\'s inbox. Same barrier as the ' +
        'renderer above, for the same reason — an authorization rule cannot help, ' +
        'because a leak would happen inside this one Lambda\'s own process.',
      from: { path: '^amplify/functions/send-proposal-email' },
      to: { path: '^packages/pricing-internal' },
    },
    {
      name: 'no-internal-pricing-in-client-packages',
      severity: 'error',
      comment:
        'Dependency direction is one-way: pricing-internal may import pricing, ' +
        'never the reverse. Otherwise confidential constants become reachable ' +
        'from anything that quotes a price.',
      from: { path: '^packages/pricing/' },
      to: { path: '^packages/pricing-internal' },
    },
    {
      name: 'no-aws-deps-in-pricing',
      severity: 'error',
      comment:
        'The pricing engine must stay pure so tier and eligibility rules are ' +
        'unit-testable without credentials.',
      from: { path: '^packages/pricing/' },
      to: { path: 'node_modules/(aws-amplify|@aws-sdk|@aws-amplify|aws-cdk-lib)' },
    },
    {
      name: 'no-aws-deps-in-domain',
      severity: 'error',
      comment: '@aeygis/domain is shared with client code and must stay dependency-free.',
      from: { path: '^packages/domain/' },
      to: { path: 'node_modules/(aws-amplify|@aws-sdk|@aws-amplify|aws-cdk-lib)' },
    },
    {
      name: 'no-internal-pricing-in-console',
      severity: 'error',
      comment:
        'The console renders figures a rep reads aloud to a client and that flow into proposals. ' +
        'It must never be able to reach internal cost or margin data, even transitively.',
      from: { path: '^apps/console' },
      to: { path: '^packages/pricing-internal' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make the boundary rules above unenforceable.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.test\\.ts$' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
