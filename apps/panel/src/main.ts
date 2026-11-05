import { startPanel } from './server.js';
try {
  startPanel();
} catch (e) {
  // Never print the token or environment; only a stable error code.
  console.error(JSON.stringify({ event: 'panel_failed', code: e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'RUNTIME_FAILURE' }));
  process.exitCode = 1;
}
