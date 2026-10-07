import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The app is served at https://2ace.pl/app/ from the committed ../app folder (the server only runs `git pull`, it cannot build).
// CI rebuilds and fails if ../app is not exactly what this source produces.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../app',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
    // Locally, the site's own files (config.js, monitor.js, login) come from the dev server in the repo root: `node dev-server.js`.
    proxy: { '^/(config\\.js|assets/monitor\\.js|login|account|terms|privacy|help)': 'http://localhost:8000' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
