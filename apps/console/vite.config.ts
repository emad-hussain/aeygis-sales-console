import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    /**
     * Belt-and-braces against a duplicate React.
     *
     * npm hoisted react@18.3.1 to the workspace root while this app declared
     * ^19.2.8, so @aws-amplify/ui-react and the app loaded DIFFERENT copies. The
     * page rendered blank with "Invalid hook call ... more than one copy of React"
     * and "Cannot read properties of null (reading 'useEffect')".
     *
     * Root `overrides` pins one version at install time; this makes Vite resolve
     * a single copy even if the tree drifts again.
     */
    dedupe: ['react', 'react-dom'],
    alias: {
      '@aeygis/domain': new URL('../../packages/domain/src/index.ts', import.meta.url).pathname,
      '@aeygis/pricing': new URL('../../packages/pricing/src/index.ts', import.meta.url).pathname,
    },
  },
  server: { port: 5173 },
});
