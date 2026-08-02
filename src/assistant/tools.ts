/**
 * Tools the agent calls over the local log: three reads plus two narrow
 * writes (create_entry / update_entry). Data access is injected —
 * createAssistantTools takes getters and an EntryWriter — so ChatScreen wires
 * the zustand store while tests inject fixtures; only text-blob reads
 * (getBlob) touch IndexedDB. Writes go through the injected store actions
 * (the single write path), so they append ordinary capture/amend events —
 * the log stays append-only and the normal sync queue picks them up. Tools
 * return terse plain text: digests for reads, "Created/Updated entry <id>."
 * or an "(error: …)" line for writes.
 */
import { jsonSchema, tool } from 'ai'
import { localDateOf, toLocalIso, zonedIso } from '../contract/time'
import type { AmendPatch, CaptureEvent, Entry } from '../contract/types'
import { getBlob, type NewAttachment } from '../store/events'
import type { Place } from '../store/places'
import { formatDigest, type DigestItem } from './context'

/** Output caps; the rendered text says so when a result is truncated. */
export const LIST_ENTRIES_MAX = 300
export const SEARCH_ENTRIES_MAX = 50

/**
 * The only writes the assistant can perform. ChatScreen injects the store's
 * capture/amend actions (the single write path); nothing else — revoke,
 * settings, sync, wipe — is reachable from a tool call.
 */
export interface EntryWriter {
  capture: (input: { capturedAt: string; attachments: NewAttachment[] }) => Promise<CaptureEvent>
  amend: (input: {
    targets: string[]
    patch?: AmendPatch
    attachments?: NewAttachment[]
  }) => Promise<void>
}

/** 24-hour wall-clock time, "HH:MM". */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function noteAttachment(text: string): NewAttachment {
  return { kind: 'text', blob: new Blob([text], { type: 'text/plain' }), mimeType: 'text/plain' }
}

/** Terse failure line the model can read; never throws out of a tool. */
function errorText(prefix: string, err: unknown): string {
  return `(error: ${prefix}: ${err instanceof Error ? err.message : String(err)})`
}

/** Digest view of one entry; reads its text attachments from blob storage. */
export async function toDigestItem(entry: Entry): Promise<DigestItem> {
  const texts: string[] = []
  for (const a of entry.attachments) {
    if (a.kind !== 'text') continue
    const blob = await getBlob(a.file)
    const text = (await blob?.text())?.trim()
    if (text) texts.push(text)
  }
  return {
    capturedAt: entry.capturedAt,
    id: entry.id,
    place: entry.location?.placeLabel,
    texts,
    audioCount: entry.attachments.filter((a) => a.kind === 'audio').length,
    photoCount: entry.attachments.filter((a) => a.kind === 'photo').length,
  }
}

/** Sorted by capture time so formatDigest's day grouping stays coherent. */
function formatSorted(items: readonly DigestItem[]): string {
  return formatDigest([...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)))
}

export function createAssistantTools(
  getEntries: () => readonly Entry[],
  getPlaces: () => readonly Place[],
  writer: EntryWriter,
) {
  // The SDK runs all tool calls of one model step concurrently
  // (Promise.all over executions), so write tools serialize through this
  // chain: each write task starts — including its getEntries() read — only
  // after the previous write has fully landed. Without it, two update_entry
  // calls on the same entry both read the pre-write snapshot, both remove
  // the same note file, and the fold keeps both replacement notes.
  let lastWrite: Promise<unknown> = Promise.resolve()
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const run = lastWrite.then(task, task)
    lastWrite = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    list_entries: tool({
      description:
        'List log entries whose capture date falls in an inclusive local-date range. Returns plain text grouped by day.',
      inputSchema: jsonSchema<{ from: string; to: string }>({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start date, YYYY-MM-DD, inclusive, user-local.' },
          to: { type: 'string', description: 'End date, YYYY-MM-DD, inclusive, user-local.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      }),
      execute: async ({ from, to }) => {
        const inRange = getEntries().filter((e) => {
          const day = e.capturedAt.slice(0, 10)
          return !e.revoked && day >= from && day <= to
        })
        const capped = inRange.slice(-LIST_ENTRIES_MAX)
        const text = formatSorted(await Promise.all(capped.map(toDigestItem)))
        return inRange.length > capped.length
          ? `${text}\n(truncated: showing the newest ${capped.length} of ${inRange.length} entries in range)`
          : text
      },
    }),

    get_places: tool({
      description: 'The user\u2019s saved places (name and detection radius).',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        const places = getPlaces()
        if (places.length === 0) return '(no saved places)'
        return places.map((p) => `- ${p.name} (radius ${p.radiusM} m)`).join('\n')
      },
    }),

    search_entries: tool({
      description:
        'Case-insensitive substring search over all entry text (transcripts and notes) in the whole log.',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to search for.' } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async ({ query }) => {
        const q = query.toLowerCase()
        const matches: DigestItem[] = []
        let total = 0
        for (const e of getEntries()) {
          if (e.revoked) continue
          const item = await toDigestItem(e)
          if (!item.texts.some((t) => t.toLowerCase().includes(q))) continue
          total++
          if (matches.length < SEARCH_ENTRIES_MAX) matches.push(item)
        }
        if (total === 0) return `(no entries matching "${query}")`
        const text = formatSorted(matches)
        return total > matches.length
          ? `${text}\n(truncated: showing the first ${matches.length} of ${total} matches)`
          : text
      },
    }),

    create_entry: tool({
      description:
        'Create a new log entry with the given note text, captured at the current time. Use only when the user explicitly asks to log something.',
      inputSchema: jsonSchema<{ text: string }>({
        type: 'object',
        properties: { text: { type: 'string', description: 'Note text of the new entry.' } },
        required: ['text'],
        additionalProperties: false,
      }),
      execute: ({ text }) =>
        enqueueWrite(async () => {
          if (typeof text !== 'string' || text.trim() === '') {
            return '(error: text must be a non-empty string)'
          }
          try {
            // Same shape the capture screen's "+ note" path appends (one
            // capture event, one text attachment); location is UI-only.
            const event = await writer.capture({
              capturedAt: toLocalIso(new Date()),
              attachments: [noteAttachment(text.trim())],
            })
            return `Created entry ${event.id}.`
          } catch (err) {
            return errorText('could not create entry', err)
          }
        }),
    }),

    update_entry: tool({
      description:
        'Update an existing log entry by id — the "(id …)" suffix in list/search results. Can replace the entry’s note text and/or set its capture time of day (the date is kept). Transcripts of recorded audio are never touched.',
      inputSchema: jsonSchema<{ id: string; text?: string; time?: string }>({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the entry to update.' },
          text: {
            type: 'string',
            description: 'New note text; replaces the entry’s existing note(s).',
          },
          time: {
            type: 'string',
            description: 'New capture time of day, "HH:MM" (24-hour, user-local).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: ({ id, text, time }) =>
        enqueueWrite(async () => {
          // Inside the write chain, so this read reflects every prior write.
          const entry = getEntries().find((e) => e.id === id)
          if (!entry) return `(error: no entry with id "${id}")`
          if (entry.revoked) return `(error: entry "${id}" is deleted)`
          if (text === undefined && time === undefined) {
            return '(error: nothing to update — provide text and/or time)'
          }
          if (text !== undefined && (typeof text !== 'string' || text.trim() === '')) {
            return '(error: text must be a non-empty string)'
          }
          if (time !== undefined && (typeof time !== 'string' || !TIME_RE.test(time))) {
            return '(error: time must be "HH:MM", 24-hour)'
          }
          // One amend event carrying every change — the same pipeline as the
          // UI edit path: editing text removes the old note files and appends
          // the new one; the log itself is never mutated.
          const patch: AmendPatch = {}
          if (time !== undefined) {
            // Recompose in the ENTRY's own zone (date from its civil fields,
            // offset from its deviceTz), exactly like editPlan's draftPatch —
            // a device-zone Date round-trip would silently move entries
            // captured in another timezone.
            patch.capturedAt = zonedIso(localDateOf(entry.capturedAt), time, entry.deviceTz)
          }
          let attachments: NewAttachment[] | undefined
          if (text !== undefined) {
            // Replace user notes only; machine-derived texts (transcripts,
            // captions — anything with derivedFrom) stay untouched.
            const notes = entry.attachments.filter(
              (a) => a.kind === 'text' && a.derivedFrom === undefined,
            )
            if (notes.length > 0) patch.removeAttachments = notes.map((a) => a.file)
            attachments = [noteAttachment(text.trim())]
          }
          try {
            await writer.amend({
              targets: [id],
              ...(Object.keys(patch).length > 0 ? { patch } : {}),
              ...(attachments ? { attachments } : {}),
            })
            return `Updated entry ${id}.`
          } catch (err) {
            return errorText('could not update entry', err)
          }
        }),
    }),
  }
}
