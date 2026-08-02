/**
 * Builds the digest text daySummaryClient sends for the opt-in prose (#82).
 * Deliberately re-implements assistant/tools.ts's `toDigestItem` rather than
 * importing it: tools.ts imports the `ai` package (for `tool`/`jsonSchema`),
 * and pulling that into dayview would drag the AI SDK chunk into the Day
 * screen's bundle (issue #82 requirement 7) even though ChatScreen already
 * loads it lazily. `formatDigest`/`DigestItem` themselves live in
 * assistant/context.ts, which has no SDK dependency, so importing those is
 * fine and keeps the rendered digest format identical to what the chat
 * assistant already sends.
 */
import type { Entry } from '../contract/types'
import { getBlob } from '../store/events'
import { formatDigest, type DigestItem } from '../assistant/context'

/** Same shape/semantics as assistant/tools.ts's toDigestItem. */
async function toDigestItem(entry: Entry): Promise<DigestItem> {
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

export interface DayDigest {
  /** One item per input entry, in the same order — callers pair these with
   *  `entries` positionally (e.g. to compute synthesisInputHash's text
   *  lengths) without a second lookup. */
  items: DigestItem[]
  /** formatDigest's rendering, chronologically sorted — what the prose
   *  prompt actually reads. */
  text: string
}

/** Reads each entry's text attachments and renders the digest the daily
 * prose is generated from. I/O (IndexedDB blob reads); not pure. */
export async function buildDayDigest(entries: readonly Entry[]): Promise<DayDigest> {
  const items = await Promise.all(entries.map(toDigestItem))
  const text = formatDigest([...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)))
  return { items, text }
}
