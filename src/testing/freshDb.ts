/**
 * Shared "fresh IndexedDB per test" wiring (issue #70), replacing the same
 * four lines that used to be hand-copied into every test file that needs
 * isolation between tests rather than just a working `indexedDB` global
 * (which `src/testing/setup.ts` now provides for the whole run): a real
 * `fake-indexeddb` `IDBFactory` stubbed onto `globalThis.indexedDB`, paired
 * with `vi.resetModules()` so `store/db.ts`'s module-level `dbPromise` memo
 * (and any other module-level cache) is dropped and reopens against the new
 * instance on the next dynamic `import()`, instead of reusing a handle bound
 * to the previous test's now-orphaned database.
 */
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, vi } from 'vitest'

/**
 * Registers `beforeEach`/`afterEach` hooks (call once at the top of a test
 * file, outside any `describe`) that give every test in the file its own
 * empty IndexedDB. Because `vi.resetModules()` runs first, callers must load
 * the module under test via a dynamic `import()` *inside* the test (or a
 * `beforeEach` that runs after this one), never a static top-of-file import,
 * or they'll be exercising the previous test's module instances against the
 * new database.
 */
export function useFreshIndexedDb(): void {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
}
