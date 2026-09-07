/**
 * Build config for the control panel's React front end.
 *
 * The app lives in `ui/` and builds into `src/panel/ui-dist/`, which the panel
 * server serves statically. That output is gitignored: it is a build artifact,
 * and committing one is how a repository ends up with a checked-in bundle that
 * silently disagrees with its own source.
 *
 * `base: './'` so the bundle works regardless of what path the panel is mounted
 * at. In dev, `vite` serves on 5173 and proxies the API and the live-session
 * WebSocket to the panel on 4200, so the React app talks to the *real* engine
 * during development rather than to fixtures — which is the only way the
 * escalation modal can be worked on at all, since it needs a parked browser
 * session on the other end.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PANEL = `http://localhost:${process.env.PANEL_PORT ?? 4200}`;

export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../src/panel/ui-dist',
    emptyOutDir: true,
    // The panel is a local tool on localhost; a sourcemap costs nothing here and
    // turns a stack trace in someone's console into a line of readable code.
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: PANEL, changeOrigin: true },
      '/ws/session': { target: PANEL, ws: true },
    },
  },
});
