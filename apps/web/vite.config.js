import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app is a standalone SPA; the API base URL and Supabase keys come from
// VITE_* env vars (see .env.example). No proxy in prod — the API lives on its own
// Render host and CORS is open on the server.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // @careeros/shared's ATS engine (spec 7.14.13) is a CommonJS workspace
  // package, resolved via an npm-workspace SYMLINK rather than a real
  // node_modules copy. Vite doesn't pre-bundle linked workspace deps by
  // default (dev), and rollup's commonjs plugin only looks inside
  // node_modules by default (build) — the symlink's real path is outside
  // that, under packages/shared. Both need to be told explicitly, or the
  // raw require()/module.exports reaches the browser untransformed.
  optimizeDeps: {
    include: [
      '@careeros/shared/src/ats/calculateAtsScore.js',
      '@careeros/shared/src/ats/atsSummary.js',
      '@careeros/shared/src/contact/linkTypes.js',
    ],
  },
  build: {
    outDir: 'dist',
    commonjsOptions: { include: [/node_modules/, /packages[\\/]shared/] },
  },
});
