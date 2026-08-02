import { describe, expect, it } from 'vitest'
import {
  emptySyncProgress,
  formatSyncProgress,
  prettyStreamName,
  reduceSyncProgress,
  syncProgressFraction,
  type SyncProgress,
} from './syncProgress'

describe('reduceSyncProgress', () => {
  it('cycle-start resets to a fresh pulling state with the given stream count', () => {
    const p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 3 })
    expect(p).toEqual({
      phase: 'pulling',
      stream: null,
      streamsDone: 0,
      streamsTotal: 3,
      itemsDone: 0,
      itemsTotal: null,
      pulled: 0,
      uploaded: 0,
    })
  })

  it('cycle-start discards any stale progress from a previous cycle', () => {
    let p: SyncProgress | null = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 5 })
    p = reduceSyncProgress(p, { kind: 'cycle-start', streamsTotal: 2 })
    expect(p.uploaded).toBe(0)
    expect(p.streamsTotal).toBe(2)
  })

  it('stream-start sets the active stream and resets item counters', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 2 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'settings', itemsTotal: 4 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    expect(p.phase).toBe('pulling')
    expect(p.stream).toBe('timelog')
    expect(p.itemsDone).toBe(0)
    expect(p.itemsTotal).toBeNull()
  })

  it('pull-progress accumulates a running cycle-wide total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'pull-progress', stream: 'timelog', delta: 3 })
    p = reduceSyncProgress(p, { kind: 'pull-progress', stream: 'timelog', delta: 2 })
    expect(p.pulled).toBe(5)
    expect(p.phase).toBe('pulling')
  })

  it('upload-start switches phase to uploading with a determinate total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 10 })
    expect(p.phase).toBe('uploading')
    expect(p.itemsTotal).toBe(10)
    expect(p.itemsDone).toBe(0)
  })

  it('upload-progress accumulates itemsDone and the cycle-wide uploaded total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 10 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 3 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 1 })
    expect(p.itemsDone).toBe(4)
    expect(p.uploaded).toBe(4)
  })

  it('stream-done increments streamsDone without touching item counters', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 3 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 })
    p = reduceSyncProgress(p, { kind: 'stream-done', stream: 'timelog' })
    expect(p.streamsDone).toBe(1)
    expect(p.itemsTotal).toBe(2)
  })

  it('cycle-done marks the phase done and clears the active stream', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    p = reduceSyncProgress(p, { kind: 'cycle-done' })
    expect(p.phase).toBe('done')
    expect(p.stream).toBeNull()
  })

  it('a stray event against a null state falls back to the empty state instead of throwing', () => {
    expect(() => reduceSyncProgress(null, { kind: 'pull-progress', stream: 'x', delta: 1 })).not.toThrow()
    const p = reduceSyncProgress(null, { kind: 'pull-progress', stream: 'x', delta: 1 })
    expect(p.pulled).toBe(1)
    expect(p.phase).toBe('idle')
  })

  it('plays a full multi-stream cycle end to end', () => {
    let p: SyncProgress | null = null
    p = reduceSyncProgress(p, { kind: 'cycle-start', streamsTotal: 2 })
    // stream 1: settings — pull finds nothing, push has 2 rows
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'settings' })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'settings', itemsTotal: 2 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'settings', delta: 2 })
    p = reduceSyncProgress(p, { kind: 'stream-done', stream: 'settings' })
    // stream 2: timelog — pull imports one page of 3, push has 1 row
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    p = reduceSyncProgress(p, { kind: 'pull-progress', stream: 'timelog', delta: 3 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 1 })
    p = reduceSyncProgress(p, { kind: 'stream-done', stream: 'timelog' })
    p = reduceSyncProgress(p, { kind: 'cycle-done' })

    expect(p).toMatchObject({
      phase: 'done',
      stream: null,
      streamsDone: 2,
      streamsTotal: 2,
      pulled: 3,
      uploaded: 3,
    })
  })
})

describe('prettyStreamName', () => {
  it.each([
    ['timelog', 'Timelog'],
    ['settings', 'Settings'],
    ['assistant-chats', 'Assistant Chats'],
  ])('%s -> %s', (id, label) => {
    expect(prettyStreamName(id)).toBe(label)
  })
})

describe('syncProgressFraction', () => {
  it('is null while idle', () => {
    expect(syncProgressFraction(emptySyncProgress())).toBeNull()
  })

  it('is null while pulling — no cheap upfront total', () => {
    const p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    expect(syncProgressFraction(p)).toBeNull()
  })

  it('is null while uploading before the total is known', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    expect(syncProgressFraction(p)).toBeNull()
  })

  it('is determinate once upload-start reports a total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 4 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 1 })
    expect(syncProgressFraction(p)).toBe(0.25)
  })

  it('never exceeds 1 even if delta overshoots the reported total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 5 })
    expect(syncProgressFraction(p)).toBe(1)
  })

  it('is 1 once done', () => {
    const p = reduceSyncProgress(null, { kind: 'cycle-done' })
    expect(syncProgressFraction(p)).toBe(1)
  })
})

describe('formatSyncProgress', () => {
  it('idle', () => {
    expect(formatSyncProgress(emptySyncProgress())).toBe('Preparing to sync…')
  })

  it('pulling, with stream position', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 3 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'assistant-chats' })
    p = reduceSyncProgress(p, { kind: 'stream-done', stream: 'assistant-chats' })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    expect(formatSyncProgress(p)).toBe('Checking Timelog for changes (2 of 3)')
  })

  it('uploading, determinate', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 12 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 3 })
    expect(formatSyncProgress(p)).toBe('Uploading 3 of 12 · Timelog')
  })

  it('uploading, indeterminate total', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'stream-start', stream: 'timelog' })
    expect(formatSyncProgress({ ...p, phase: 'uploading' })).toBe('Uploading · Timelog')
  })

  it('done, with counts', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 })
    p = reduceSyncProgress(p, { kind: 'upload-progress', stream: 'timelog', delta: 2 })
    p = reduceSyncProgress(p, { kind: 'pull-progress', stream: 'timelog', delta: 1 })
    p = reduceSyncProgress(p, { kind: 'cycle-done' })
    expect(formatSyncProgress(p)).toBe('Synced — 2 uploaded · 1 pulled')
  })

  it('done, nothing happened', () => {
    let p = reduceSyncProgress(null, { kind: 'cycle-start', streamsTotal: 1 })
    p = reduceSyncProgress(p, { kind: 'cycle-done' })
    expect(formatSyncProgress(p)).toBe('Already up to date')
  })
})
