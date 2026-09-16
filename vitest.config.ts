import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only pure, AWS-free tests run here. Anything needing a deployed backend
    // is a manual verification step in docs/deployment.md, not a unit test —
    // a test suite that silently requires credentials is a trap.
    include: [
      'packages/**/*.test.ts',
      'amplify/**/*.test.ts',
      // The console's DECISION logic (reducers, pure helpers) — never its
      // components. Anything that needs a DOM is covered by check:ui.
      'apps/console/src/**/*.test.ts',
    ],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@aeygis/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@aeygis/pricing': new URL('./packages/pricing/src/index.ts', import.meta.url).pathname,
      '@aeygis/pricing-internal': new URL('./packages/pricing-internal/src/index.ts', import.meta.url).pathname,
    },
  },
});
