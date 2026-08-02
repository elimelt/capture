/**
 * Read-only tools the agent calls over the local log. Data access is
 * injected — createAssistantTools takes getters — so ChatScreen wires the
 * zustand store while tests inject fixtures; only text-blob reads (getBlob)
 * touch IndexedDB. Tools return plain text in the formatDigest rendering.
 */
import { jsonSchema, tool } from 'ai'
import type { Entry } from '../contract/types'
import { getBlob } from '../store/events'
import type { Place } from '../store/places'
import { formatDigest, type DigestItem } from './context'

/** Output caps; the rendered text says so when a result is truncated. */
export const LIST_ENTRIES_MAX = 300
export const SEARCH_ENTRIES_MAX = 50

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
) {
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
  }
}
