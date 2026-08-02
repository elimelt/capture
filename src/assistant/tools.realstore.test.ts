/**
 * Write-tool regression tests against the REAL store (useAppStore + the
 * real IndexedDB event repository via fake-indexeddb + the real fold) —
 * not the hand-rolled EntryWriter mock tools.test.ts uses for its fixture
 * tests. A mock can quietly "assume the answer"; these tests exercise the
 * exact wiring ChatScreen builds (createAssistantTools over
 * useAppStore.getState().capture/amend/revoke) so a real regression in the
 * write path — an amend that isn't merged by the fold, a revoke that
 * doesn't tombstone, a race that isn't serialized — shows up here even if
 * a mock-based test would stay green.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDbCache } from '../store/db'
import { useAppStore } from '../store/appStore'
import { createAssistantTools, type EntryWriter } from './tools'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
  await useAppStore.getState().init()
})

const OPTS = { toolCallId: 'test', messages: [], context: {} }

/** The exact wiring ChatScreen.getChat builds: store actions, no shortcuts. */
function realWriter(): EntryWriter {
  return {
    capture: (input) => useAppStore.getState().capture(input),
    amend: (input) => useAppStore.getState().amend(input),
    revoke: (targets) => useAppStore.getState().revoke(targets),
  }
}

function realTools() {
  return createAssistantTools(
    () => useAppStore.getState().entries,
    () => useAppStore.getState().places,
    realWriter(),
  )
}

describe('update_entry against the real store', () => {
  it('amends the target entry in place — the log never gains a second entry', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [{ kind: 'text', blob: new Blob(['hello']), mimeType: 'text/plain' }],
    })
    expect(useAppStore.getState().entries).toHaveLength(1)

    const tools = realTools()
    const result = (await tools.update_entry.execute(
      { id: created.id, text: 'updated text' },
      OPTS,
    )) as string

    expect(result).toBe(`Updated entry ${created.id}.`)
    // The failing-test-first repro this pins: a broken update_entry that
    // emitted a fresh capture instead of an amend (or an amend the fold
    // couldn't merge back onto the target) would leave TWO entries here.
    const entries = useAppStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(created.id)
  })

  it('repeated updates never accumulate extra entries', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [{ kind: 'text', blob: new Blob(['hello']), mimeType: 'text/plain' }],
    })
    const tools = realTools()
    for (let i = 0; i < 3; i++) {
      await tools.update_entry.execute({ id: created.id, text: `edit ${i}` }, OPTS)
      expect(useAppStore.getState().entries).toHaveLength(1)
    }
  })

  it('serializes two concurrent update_entry calls on the same entry through enqueueWrite', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [{ kind: 'text', blob: new Blob(['hello']), mimeType: 'text/plain' }],
    })
    const tools = realTools()
    const results = await Promise.all([
      tools.update_entry.execute({ id: created.id, text: 'first' }, OPTS),
      tools.update_entry.execute({ id: created.id, text: 'second' }, OPTS),
    ])
    expect(results).toEqual([`Updated entry ${created.id}.`, `Updated entry ${created.id}.`])
    // Still one entry (not duplicated by the race) and exactly one note
    // (the second amend's replacement — not both notes, per enqueueWrite).
    const entries = useAppStore.getState().entries
    expect(entries).toHaveLength(1)
    const notes = entries[0].attachments.filter((a) => a.kind === 'text')
    expect(notes).toHaveLength(1)
  })
})

describe('delete_entry against the real store', () => {
  it('emits a revoke that the fold tombstones — the entry disappears from the folded view', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [{ kind: 'text', blob: new Blob(['walked the dog'], { type: 'text/plain' }), mimeType: 'text/plain' }],
    })
    expect(useAppStore.getState().entries).toHaveLength(1)

    const tools = realTools()
    const result = (await tools.delete_entry.execute({ id: created.id }, OPTS)) as string

    expect(result).toContain(`Deleted entry ${created.id}`)
    expect(result).toContain('walked the dog')
    // fold() drops revoked entries by default (contract/fold.ts) — the
    // tombstone hides the entry from every view without erasing the log.
    expect(useAppStore.getState().entries).toHaveLength(0)
  })

  it('a second delete on the same id returns a clear error, not a throw', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [],
    })
    const tools = realTools()
    const first = (await tools.delete_entry.execute({ id: created.id }, OPTS)) as string
    expect(first).toContain('Deleted entry')

    const second = (await tools.delete_entry.execute({ id: created.id }, OPTS)) as string
    // The real store's fold already excludes revoked entries, so a repeat
    // delete resolves the same way an unknown id would — still a terse,
    // non-throwing error the model can relay.
    expect(second).toBe(`(error: no entry with id "${created.id}")`)
  })

  it('deleting an unknown id returns a clear error, not a throw', async () => {
    const tools = realTools()
    const result = (await tools.delete_entry.execute({ id: 'does-not-exist' }, OPTS)) as string
    expect(result).toBe('(error: no entry with id "does-not-exist")')
  })

  it('does not remove the event log — the capture and revoke events both persist', async () => {
    const created = await useAppStore.getState().capture({
      capturedAt: '2026-08-02T07:45:00-04:00',
      attachments: [],
    })
    const tools = realTools()
    await tools.delete_entry.execute({ id: created.id }, OPTS)

    const { listEvents } = await import('../store/events')
    const events = await listEvents('timelog')
    expect(events.map((e) => e.type).sort()).toEqual(['capture', 'revoke'])
    expect(events.find((e) => e.type === 'revoke')?.targets).toEqual([created.id])
  })
})
