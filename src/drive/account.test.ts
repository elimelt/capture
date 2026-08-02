import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncStatusRow } from '../store/db'

/**
 * Fake identity + id-minting endpoints, in the style of the other drive/
 * suites: the fake account is switchable per test, and generateIds counts
 * mints so pool resets are observable.
 */
function fakeDrive() {
  let user = 'user-A'
  let n = 0
  return {
    getAboutUser: vi.fn(async (_t: string) => ({ permissionId: user })),
    generateIds: vi.fn(async (_t: string, count: number) =>
      Array.from({ length: count }, () => `gen-${n++}`),
    ),
    setUser(id: string) {
      user = id
    },
  }
}

let drive: ReturnType<typeof fakeDrive>

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return {
    ...actual,
    getAboutUser: (...args: unknown[]) => drive.getAboutUser(...(args as [string])),
    generateIds: (...args: unknown[]) => drive.generateIds(...(args as [string, number])),
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  drive = fakeDrive()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function row(overrides: Partial<SyncStatusRow>): SyncStatusRow {
  return {
    id: 'ev-1',
    stream: 'timelog',
    seq: 1,
    status: 'queued',
    phase: 'record-pending',
    attempts: 1,
    ...overrides,
  }
}

/** Seed the full set of account-bound state a device accumulates. */
async function seedAccountBoundState() {
  const { saveTree, emptyStreamTree } = await import('./tree')
  const st = emptyStreamTree('folder-1', 'log-1', 'results-1')
  st.partitions['2026-08-02'] = 'part-1'
  await saveTree({ rootId: 'root-1', streams: { timelog: st } })
  const { saveChangesToken } = await import('./changes')
  await saveChangesToken('timelog', 'cursor-timelog')
  await saveChangesToken('settings', 'cursor-settings')
  const { putSyncStatus } = await import('../store/events')
  await putSyncStatus(row({ id: 'ev-queued', fileIds: { 'a.json': 'id-a' } }))
  await putSyncStatus(
    row({ id: 'ev-done', seq: 2, status: 'uploaded', phase: 'done', fileIds: { 'b.json': 'id-b' } }),
  )
}

describe('ensureAccountBound', () => {
  it('first grant (no stored identity) binds without discarding anything', async () => {
    await seedAccountBoundState()
    const { ensureAccountBound, getStoredAccountId } = await import('./account')

    expect(await ensureAccountBound('tok')).toBe(false)

    expect(await getStoredAccountId()).toBe('user-A')
    const { getTree } = await import('./tree')
    expect((await getTree())!.streams.timelog.partitions['2026-08-02']).toBe('part-1')
    const { getChangesToken } = await import('./changes')
    expect(await getChangesToken('timelog')).toBe('cursor-timelog')
    const { getSyncStatuses } = await import('../store/events')
    expect((await getSyncStatuses('timelog')).get('ev-queued')?.fileIds).toEqual({
      'a.json': 'id-a',
    })
  })

  it('same account keeps everything; the check is memoized per token', async () => {
    const { ensureAccountBound } = await import('./account')
    await ensureAccountBound('tok-1')
    await seedAccountBoundState()

    expect(await ensureAccountBound('tok-1')).toBe(false) // memoized: no request
    expect(drive.getAboutUser).toHaveBeenCalledTimes(1)
    expect(await ensureAccountBound('tok-2')).toBe(false) // reconnect, same account
    expect(drive.getAboutUser).toHaveBeenCalledTimes(2)

    const { getTree } = await import('./tree')
    expect((await getTree())!.streams.timelog.partitions['2026-08-02']).toBe('part-1')
    const { getChangesToken } = await import('./changes')
    expect(await getChangesToken('timelog')).toBe('cursor-timelog')
  })

  it('an account switch discards tree, all cursors, and pending fileIds, then re-binds', async () => {
    const { ensureAccountBound, getStoredAccountId } = await import('./account')
    await ensureAccountBound('tok-a')
    await seedAccountBoundState()

    drive.setUser('user-B')
    expect(await ensureAccountBound('tok-b')).toBe(true)

    expect(await getStoredAccountId()).toBe('user-B')
    const { getTree } = await import('./tree')
    expect(await getTree()).toBeUndefined()
    const { getChangesToken } = await import('./changes')
    expect(await getChangesToken('timelog')).toBeUndefined()
    expect(await getChangesToken('settings')).toBeUndefined()

    const { getSyncStatuses } = await import('../store/events')
    const rows = await getSyncStatuses('timelog')
    // Pending rows lose their old-account ids (the legacy probe takes over) …
    expect(rows.get('ev-queued')?.fileIds).toBeUndefined()
    expect(rows.get('ev-queued')?.status).toBe('queued')
    expect(rows.get('ev-queued')?.attempts).toBe(1)
    // … while uploaded rows (already landed on the old account) are untouched.
    expect(rows.get('ev-done')?.fileIds).toEqual({ 'b.json': 'id-b' })
  })

  it('an account switch drops pooled pre-generated ids minted with the old token', async () => {
    const { allocateIds } = await import('./ids')
    await allocateIds('tok-a', 1) // mints a batch; 9 ids stay pooled
    expect(drive.generateIds).toHaveBeenCalledTimes(1)

    const { ensureAccountBound } = await import('./account')
    await ensureAccountBound('tok-a')
    drive.setUser('user-B')
    await ensureAccountBound('tok-b')

    await allocateIds('tok-b', 1) // pool was reset: must mint fresh ids
    expect(drive.generateIds).toHaveBeenCalledTimes(2)
  })
})
