/**
 * Test config, separate from `vite.config.ts` on purpose.
 *
 * Vitest reads `vite.config.ts` when there is no config of its own — and this
 * repo's Vite config sets `root: 'ui'` for the React front end, which quietly
 * pointed the whole test suite at a directory containing no tests. It did not
 * fail loudly; it reported "No test files found" and exited 1, which in CI
 * looks like a broken suite and locally looks like nothing at all.
 *
 * A `vitest.config.ts` takes precedence, so the two roots stay separate: Vite
 * builds `ui/`, Vitest tests the repo.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    // The end-to-end suite drives a real browser against the bundled CoreBank
    // app, so individual cases are allowed to take a while.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
