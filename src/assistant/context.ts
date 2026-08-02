/**
 * Context digestion: folds the recent log into a compact plain-text digest
 * the model can reason over. Pure formatting (formatDigest, recentEntries)
 * is separated from blob I/O (buildInstructions) so it tests without
 * IndexedDB. capturedAt is local ISO with offset — sliced for date/time,
 * never round-tripped through Date, so the digest shows wall-clock time.
 */
import type { Entry } from '../contract/types'
import { deviceTz, toLocalIso } from '../contract/time'
import { getBlob } from '../store/events'

/** How much history the assistant sees. */
export const DIGEST_DAYS = 7
export const DIGEST_MAX_ENTRIES = 200

export interface DigestItem {
  /** Local ISO with offset (entry.capturedAt). */
  capturedAt: string
  place?: string
  /** Transcript + note texts, in display order. */
  texts: string[]
  audioCount: number
  photoCount: number
}

/** Non-revoked entries captured within the digest window, newest-capped. */
export function recentEntries(entries: readonly Entry[], now: Date = new Date()): Entry[] {
  const cutoff = now.getTime() - DIGEST_DAYS * 86_400_000
  return entries
    .filter((e) => !e.revoked && new Date(e.capturedAt).getTime() >= cutoff)
    .slice(-DIGEST_MAX_ENTRIES)
}

export function formatDigest(items: readonly DigestItem[]): string {
  if (items.length === 0) return '(no entries in this period)'
  const lines: string[] = []
  let day = ''
  for (const it of items) {
    const d = it.capturedAt.slice(0, 10)
    if (d !== day) {
      if (day !== '') lines.push('')
      day = d
      lines.push(`${d}:`)
    }
    const media: string[] = []
    if (it.audioCount > 0) media.push(`${it.audioCount} audio`)
    if (it.photoCount > 0) media.push(`${it.photoCount} photo${it.photoCount > 1 ? 's' : ''}`)
    const body = [
      it.texts.join(' | ') || undefined,
      media.length > 0 ? `[${media.join(', ')}]` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
    const place = it.place ? ` @ ${it.place}` : ''
    lines.push(`- ${it.capturedAt.slice(11, 16)}${place} — ${body || '(empty entry)'}`)
  }
  return lines.join('\n')
}

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
    place: entry.location?.placeLabel,
    texts,
    audioCount: entry.attachments.filter((a) => a.kind === 'audio').length,
    photoCount: entry.attachments.filter((a) => a.kind === 'photo').length,
  }
}

/** The system prompt: role + current time + digest of the recent log. */
export async function buildInstructions(
  entries: readonly Entry[],
  now: Date = new Date(),
): Promise<string> {
  const items = await Promise.all(recentEntries(entries, now).map(toDigestItem))
  return [
    'You are the assistant inside Timebox, a personal time and location log.',
    'The user records entries through the day: voice notes (transcribed), typed notes, and photos.',
    'Answer questions about their log: what they did, when, where, patterns and summaries.',
    'Be concise and concrete. Use the digest below as ground truth; if it does not contain the answer, say so instead of guessing.',
    'Times in the digest are the user\u2019s local wall-clock time. Format: "- HH:MM [@ place] \u2014 entry text [media]".',
    '',
    `Current local time: ${toLocalIso(now)} (${deviceTz()}).`,
    '',
    `Log entries from the last ${DIGEST_DAYS} days:`,
    formatDigest(items),
  ].join('\n')
}
