/**
 * Vitest global setup (`test.setupFiles` in `vite.config.ts`, issue #70):
 * installs the `fake-indexeddb` polyfill once for the whole run so every
 * test file that touches `store/db.ts` (directly or transitively) gets a
 * working `indexedDB` global without repeating `import 'fake-indexeddb/auto'`
 * itself. Tests that need a *fresh, empty* database per test (rather than one
 * shared instance across the file) still opt in explicitly via
 * `useFreshIndexedDb()` in `src/testing/freshDb.ts`.
 */
import 'fake-indexeddb/auto'
