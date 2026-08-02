import { beforeEach, describe, expect, it } from 'vitest'
import { fold } from '../contract/fold'
import {
  EVENT_SCHEMA,
  type AmendPatch,
  type Entry,
  type LogEvent,
} from '../contract/types'
import { getDb, resetDbCache } from '../store/db'
import type { NewAttachment } from '../store/events'
import type { Place } from '../store/places'
import {
  LIST_ENTRIES_MAX,
  SEARCH_ENTRIES_MAX,
  createAssistantTools,
  type EntryWriter,
} from './tools'

let seq = 0
function entry(capturedAt: string, extra: Partial<Entry> = {}): Entry {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    stream: 'timelog',
    loggedAt: capturedAt,
    capturedAt,
    deviceTz: 'America/New_York',
    attachments: [],
    lastEventSeq: seq,
    revoked: false,
    ...extra,
  }
}

function textEntry(capturedAt: string, file: string, extra: Partial<Entry> = {}): Entry {
  return entry(capturedAt, {
    attachments: [{ kind: 'text', file, mimeType: 'text/plain' }],
    ...extra,
  })
}

async function putBlob(file: string, text: string): Promise<void> {
  const db = await getDb()
  await db.put('blobs', { file, blob: new Blob([text], { type: 'text/plain' }) })
}

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
})

const OPTS = { toolCallId: 'test', messages: [], context: {} }

/** Writer that records every call; capture mints ids new1, new2, … */
function recordedWriter() {
  const captures: Array<{ capturedAt: string; attachments: NewAttachment[] }> = []
  const amends: Array<{
    targets: string[]
    patch?: AmendPatch
    attachments?: NewAttachment[]
  }> = []
  const revokes: string[][] = []
  const writer: EntryWriter = {
    capture: async (input) => {
      captures.push(input)
      return {
        schema: EVENT_SCHEMA,
        type: 'capture',
        id: `new${captures.length}`,
        seq: captures.length,
        stream: 'timelog',
        loggedAt: input.capturedAt,
        deviceTz: 'America/New_York',
        capturedAt: input.capturedAt,
        attachments: [],
      }
    },
    amend: async (input) => {
      amends.push(input)
    },
    revoke: async (targets) => {
      revokes.push(targets)
    },
  }
  return { writer, captures, amends, revokes }
}

function makeTools(entries: Entry[], places: Place[] = [], writer = recordedWriter().writer) {
  return createAssistantTools(
    () => entries,
    () => places,
    writer,
  )
}

describe('list_entries', () => {
  it('keeps only entries whose local date falls in the inclusive range', async () => {
    const entries = [
      entry('2026-07-31T23:59:00-04:00'),
      entry('2026-08-01T00:00:00-04:00'),
      entry('2026-08-02T23:59:00-04:00'),
      entry('2026-08-03T00:00:00-04:00'),
    ]
    const tools = makeTools(entries)
    const text = (await tools.list_entries.execute({ from: '2026-08-01', to: '2026-08-02' }, OPTS)) as string
    expect(text).toContain('2026-08-01:')
    expect(text).toContain('2026-08-02:')
    expect(text).not.toContain('2026-07-31')
    expect(text).not.toContain('2026-08-03')
  })

  it('excludes revoked entries and reads text blobs', async () => {
    await putBlob('note.txt', 'walked the dog')
    const kept = textEntry('2026-08-02T07:45:00-04:00', 'note.txt', {
      location: { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Home' },
    })
    const revoked = entry('2026-08-02T09:00:00-04:00', { revoked: true })
    const tools = makeTools([kept, revoked])
    const text = (await tools.list_entries.execute({ from: '2026-08-02', to: '2026-08-02' }, OPTS)) as string
    expect(text).toContain(`- 07:45 @ Home — walked the dog (id ${kept.id})`)
    expect(text).not.toContain('09:00')
  })

  it('reports the empty range', async () => {
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')])
    const text = (await tools.list_entries.execute({ from: '2026-01-01', to: '2026-01-31' }, OPTS)) as string
    expect(text).toBe('(no entries in this period)')
  })

  it('caps the output at the newest LIST_ENTRIES_MAX entries and says so', async () => {
    const entries = Array.from({ length: LIST_ENTRIES_MAX + 5 }, () =>
      entry('2026-08-01T10:00:00-04:00'),
    )
    const tools = makeTools(entries)
    const text = (await tools.list_entries.execute({ from: '2026-08-01', to: '2026-08-01' }, OPTS)) as string
    expect(text).toContain(
      `(truncated: showing the newest ${LIST_ENTRIES_MAX} of ${LIST_ENTRIES_MAX + 5} entries in range)`,
    )
  })
})

describe('get_places', () => {
  it('lists saved places with their radius', async () => {
    const places: Place[] = [
      { id: 'p1', name: 'Home', lat: 40.7, lng: -74, radiusM: 100 },
      { id: 'p2', name: 'Office', lat: 40.8, lng: -74.1, radiusM: 250 },
    ]
    const tools = makeTools([], places)
    const text = (await tools.get_places.execute({}, OPTS)) as string
    expect(text).toBe('- Home (radius 100 m)\n- Office (radius 250 m)')
  })

  it('reports when no places are saved', async () => {
    const tools = makeTools([])
    expect((await tools.get_places.execute({}, OPTS)) as string).toBe('(no saved places)')
  })
})

describe('search_entries', () => {
  it('matches case-insensitively across the whole log and skips revoked entries', async () => {
    await putBlob('a.txt', 'Walked the DOG in the park')
    await putBlob('b.txt', 'groceries')
    const match = textEntry('2025-01-15T08:00:00-05:00', 'a.txt')
    const miss = textEntry('2026-08-02T09:00:00-04:00', 'b.txt')
    const revoked = textEntry('2026-08-02T10:00:00-04:00', 'a.txt', { revoked: true })
    const tools = makeTools([match, miss, revoked])
    const text = (await tools.search_entries.execute({ query: 'dog' }, OPTS)) as string
    expect(text).toContain('2025-01-15:')
    expect(text).toContain('Walked the DOG in the park')
    expect(text).not.toContain('groceries')
    expect(text).not.toContain('10:00')
  })

  it('reports when nothing matches', async () => {
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')])
    const text = (await tools.search_entries.execute({ query: 'unicorn' }, OPTS)) as string
    expect(text).toBe('(no entries matching "unicorn")')
  })

  it('caps matches at SEARCH_ENTRIES_MAX and says so', async () => {
    await putBlob('note.txt', 'standup meeting')
    const entries = Array.from({ length: SEARCH_ENTRIES_MAX + 3 }, () =>
      textEntry('2026-08-01T10:00:00-04:00', 'note.txt'),
    )
    const tools = makeTools(entries)
    const text = (await tools.search_entries.execute({ query: 'STANDUP' }, OPTS)) as string
    expect(text).toContain(
      `(truncated: showing the first ${SEARCH_ENTRIES_MAX} of ${SEARCH_ENTRIES_MAX + 3} matches)`,
    )
  })
})

describe('create_entry', () => {
  it('appends exactly one capture event with the trimmed note text and returns the id', async () => {
    const w = recordedWriter()
    const tools = makeTools([], [], w.writer)
    const result = (await tools.create_entry.execute({ text: '  had lunch  ' }, OPTS)) as string
    expect(result).toBe('Created entry new1.')
    expect(w.captures).toHaveLength(1)
    expect(w.amends).toHaveLength(0)
    const input = w.captures[0]
    // Local ISO with offset, like every UI capture.
    expect(input.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(input.attachments).toHaveLength(1)
    const a = input.attachments[0]
    expect(a.kind).toBe('text')
    expect(a.mimeType).toBe('text/plain')
    expect(await a.blob.text()).toBe('had lunch')
  })

  it('rejects empty text without appending anything', async () => {
    const w = recordedWriter()
    const tools = makeTools([], [], w.writer)
    const result = (await tools.create_entry.execute({ text: '   ' }, OPTS)) as string
    expect(result).toBe('(error: text must be a non-empty string)')
    expect(w.captures).toHaveLength(0)
    expect(w.amends).toHaveLength(0)
  })

  it('reports a failed write as terse error text instead of throwing', async () => {
    const w = recordedWriter()
    w.writer.capture = async () => {
      throw new Error('idb closed')
    }
    const tools = makeTools([], [], w.writer)
    const result = (await tools.create_entry.execute({ text: 'x' }, OPTS)) as string
    expect(result).toBe('(error: could not create entry: idb closed)')
  })
})

describe('update_entry', () => {
  /** An entry with a user note, an audio clip, and its derived transcript. */
  function noteAndTranscriptEntry(): Entry {
    return entry('2026-08-02T07:45:00-04:00', {
      attachments: [
        { kind: 'text', file: 'note.txt', mimeType: 'text/plain' },
        { kind: 'audio', file: 'clip.webm', mimeType: 'audio/webm', durationSec: 12 },
        {
          kind: 'text',
          file: 'transcript.txt',
          mimeType: 'text/plain',
          derivedFrom: 'clip.webm',
        },
      ],
    })
  }

  it('replaces the user note in exactly one amend event, preserving transcripts', async () => {
    const target = noteAndTranscriptEntry()
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute(
      { id: target.id, text: ' fixed the fence ' },
      OPTS,
    )) as string
    expect(result).toBe(`Updated entry ${target.id}.`)
    expect(w.amends).toHaveLength(1)
    expect(w.captures).toHaveLength(0)
    const amend = w.amends[0]
    expect(amend.targets).toEqual([target.id])
    // Only the user note is removed — never the derived transcript.
    expect(amend.patch).toEqual({ removeAttachments: ['note.txt'] })
    expect(amend.attachments).toHaveLength(1)
    expect(amend.attachments![0].kind).toBe('text')
    expect(amend.attachments![0].mimeType).toBe('text/plain')
    expect(await amend.attachments![0].blob.text()).toBe('fixed the fence')
  })

  it('adds a note without a patch when the entry has none to replace', async () => {
    const target = entry('2026-08-02T07:45:00-04:00')
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    await tools.update_entry.execute({ id: target.id, text: 'note' }, OPTS)
    expect(w.amends).toHaveLength(1)
    expect(w.amends[0].patch).toBeUndefined()
    expect(w.amends[0].attachments).toHaveLength(1)
  })

  it('sets the capture time of day, keeping the date and attachments alone', async () => {
    const target = noteAndTranscriptEntry() // 2026-08-02T07:45:00-04:00, America/New_York
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute({ id: target.id, time: '09:30' }, OPTS)) as string
    expect(result).toBe(`Updated entry ${target.id}.`)
    expect(w.amends).toHaveLength(1)
    expect(w.amends[0]).toEqual({
      targets: [target.id],
      patch: { capturedAt: '2026-08-02T09:30:00-04:00' },
    })
  })

  it("recomposes the time in the ENTRY's zone, not the device's", async () => {
    // Captured in Tokyo, edited from a device in another zone: the civil
    // date and the offset must stay Tokyo's. A device-zone Date round-trip
    // (the harness runs outside +09:00) would move the instant and rewrite
    // the offset.
    const target = entry('2026-08-03T00:30:00+09:00', { deviceTz: 'Asia/Tokyo' })
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    await tools.update_entry.execute({ id: target.id, time: '08:15' }, OPTS)
    expect(w.amends).toHaveLength(1)
    expect(w.amends[0].patch).toEqual({ capturedAt: '2026-08-03T08:15:00+09:00' })
  })

  it('applies text and time together as a single amend event', async () => {
    const target = noteAndTranscriptEntry()
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    await tools.update_entry.execute({ id: target.id, text: 'new', time: '18:05' }, OPTS)
    expect(w.amends).toHaveLength(1)
    const amend = w.amends[0]
    expect(amend.patch).toEqual({
      capturedAt: '2026-08-02T18:05:00-04:00',
      removeAttachments: ['note.txt'],
    })
    expect(amend.attachments).toHaveLength(1)
  })

  it('serializes concurrent updates so the fold converges to exactly one note', async () => {
    // The AI SDK runs all tool calls of one model step concurrently. Fold a
    // real event log in the writer so each update_entry sees the entries
    // the previous amend produced — unserialized, both calls would remove
    // the same note file and the entry would end up with BOTH new notes.
    const events: LogEvent[] = [
      {
        schema: EVENT_SCHEMA,
        type: 'capture',
        id: 'cap1',
        seq: 1,
        stream: 'timelog',
        loggedAt: '2026-08-02T07:45:00-04:00',
        capturedAt: '2026-08-02T07:45:00-04:00',
        deviceTz: 'America/New_York',
        attachments: [{ kind: 'text', file: 'note.txt', mimeType: 'text/plain' }],
      },
    ]
    let entries = fold(events)
    let n = 0
    const writer: EntryWriter = {
      capture: () => Promise.reject(new Error('unused')),
      revoke: () => Promise.reject(new Error('unused')),
      amend: async ({ targets, patch, attachments }) => {
        // Genuinely asynchronous, like the real IndexedDB transaction — a
        // synchronous mock would let an unserialized second call read the
        // refolded entries by accident and mask the race.
        await new Promise((resolve) => setTimeout(resolve, 0))
        n += 1
        events.push({
          schema: EVENT_SCHEMA,
          type: 'amend',
          id: `am${n}`,
          seq: 1 + n,
          stream: 'timelog',
          loggedAt: `2026-08-02T12:0${n}:00-04:00`,
          deviceTz: 'America/New_York',
          targets,
          ...(patch ? { patch } : {}),
          ...(attachments && attachments.length > 0
            ? {
                attachments: attachments.map((a, i) => ({
                  kind: a.kind,
                  file: `amend${n}-${i}.txt`,
                  mimeType: a.mimeType,
                })),
              }
            : {}),
        })
        entries = fold(events)
      },
    }
    const tools = createAssistantTools(
      () => entries,
      () => [],
      writer,
    )
    const results = await Promise.all([
      tools.update_entry.execute({ id: 'cap1', text: 'first rewrite' }, OPTS),
      tools.update_entry.execute({ id: 'cap1', text: 'second rewrite' }, OPTS),
    ])
    expect(results).toEqual(['Updated entry cap1.', 'Updated entry cap1.'])
    const notes = entries
      .find((e) => e.id === 'cap1')!
      .attachments.filter((a) => a.kind === 'text')
    // Exactly one note survives: the second update replaced the first's.
    expect(notes.map((a) => a.file)).toEqual(['amend2-0.txt'])
  })

  it('rejects an unknown id without appending anything', async () => {
    const w = recordedWriter()
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')], [], w.writer)
    const result = (await tools.update_entry.execute({ id: 'nope', text: 'x' }, OPTS)) as string
    expect(result).toBe('(error: no entry with id "nope")')
    expect(w.amends).toHaveLength(0)
    expect(w.captures).toHaveLength(0)
  })

  it('rejects a revoked entry without appending anything', async () => {
    const target = entry('2026-08-02T10:00:00-04:00', { revoked: true })
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute({ id: target.id, text: 'x' }, OPTS)) as string
    expect(result).toBe(`(error: entry "${target.id}" is deleted)`)
    expect(w.amends).toHaveLength(0)
  })

  it.each(['9:30', '24:00', '10:60', 'noon'])(
    'rejects malformed time "%s" without appending anything',
    async (time) => {
      const target = entry('2026-08-02T10:00:00-04:00')
      const w = recordedWriter()
      const tools = makeTools([target], [], w.writer)
      const result = (await tools.update_entry.execute({ id: target.id, time }, OPTS)) as string
      expect(result).toBe('(error: time must be "HH:MM", 24-hour)')
      expect(w.amends).toHaveLength(0)
    },
  )

  it('rejects empty replacement text without appending anything', async () => {
    const target = entry('2026-08-02T10:00:00-04:00')
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute({ id: target.id, text: ' ' }, OPTS)) as string
    expect(result).toBe('(error: text must be a non-empty string)')
    expect(w.amends).toHaveLength(0)
  })

  it('rejects a call with nothing to change without appending anything', async () => {
    const target = entry('2026-08-02T10:00:00-04:00')
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute({ id: target.id }, OPTS)) as string
    expect(result).toBe('(error: nothing to update — provide text and/or time)')
    expect(w.amends).toHaveLength(0)
  })

  it('reports a failed write as terse error text instead of throwing', async () => {
    const target = entry('2026-08-02T10:00:00-04:00')
    const w = recordedWriter()
    w.writer.amend = async () => {
      throw new Error('idb closed')
    }
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.update_entry.execute({ id: target.id, text: 'x' }, OPTS)) as string
    expect(result).toBe('(error: could not update entry: idb closed)')
  })
})

describe('delete_entry', () => {
  it('revokes the entry in one call and confirms what was deleted', async () => {
    await putBlob('note.txt', 'walked the dog')
    const target = textEntry('2026-08-02T07:45:00-04:00', 'note.txt', {
      location: { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Home' },
    })
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.delete_entry.execute({ id: target.id }, OPTS)) as string
    expect(w.revokes).toEqual([[target.id]])
    expect(w.amends).toHaveLength(0)
    expect(w.captures).toHaveLength(0)
    // The result names the entry's content so the model can tell the user
    // what was removed without showing a raw id in prose.
    expect(result).toBe(`Deleted entry ${target.id}: 2026-08-02 07:45 @ Home — walked the dog`)
  })

  it('rejects an unknown id without revoking anything', async () => {
    const w = recordedWriter()
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')], [], w.writer)
    const result = (await tools.delete_entry.execute({ id: 'nope' }, OPTS)) as string
    expect(result).toBe('(error: no entry with id "nope")')
    expect(w.revokes).toHaveLength(0)
  })

  it('rejects a double-delete (already-revoked entry) without revoking again', async () => {
    const target = entry('2026-08-02T10:00:00-04:00', { revoked: true })
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.delete_entry.execute({ id: target.id }, OPTS)) as string
    expect(result).toBe(`(error: entry "${target.id}" is already deleted)`)
    expect(w.revokes).toHaveLength(0)
  })

  it('reports a failed write as terse error text instead of throwing', async () => {
    const target = entry('2026-08-02T10:00:00-04:00')
    const w = recordedWriter()
    w.writer.revoke = async () => {
      throw new Error('idb closed')
    }
    const tools = makeTools([target], [], w.writer)
    const result = (await tools.delete_entry.execute({ id: target.id }, OPTS)) as string
    expect(result).toBe('(error: could not delete entry: idb closed)')
  })

  it('serializes with a concurrent update_entry on the same id (write chain order)', async () => {
    // The AI SDK runs one step's tool calls concurrently; a delete racing an
    // update on the same entry must still resolve deterministically through
    // the shared enqueueWrite chain rather than interleaving reads/writes.
    const target = entry('2026-08-02T07:45:00-04:00')
    const w = recordedWriter()
    const tools = makeTools([target], [], w.writer)
    const results = await Promise.all([
      tools.update_entry.execute({ id: target.id, text: 'edit' }, OPTS),
      tools.delete_entry.execute({ id: target.id }, OPTS),
    ])
    expect(results).toEqual([`Updated entry ${target.id}.`, `Deleted entry ${target.id}: 2026-08-02 07:45 — (empty entry)`])
    expect(w.amends).toHaveLength(1)
    expect(w.revokes).toEqual([[target.id]])
  })
})
