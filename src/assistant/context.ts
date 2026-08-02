/**
 * Assistant prompt + shared log rendering. The model reads the log on demand
 * through read-only tools (see tools.ts), so the system prompt stays compact:
 * role, data model, tool usage, current local time. Everything here is pure
 * formatting — blob I/O lives in tools.ts — so it tests without IndexedDB.
 * capturedAt is local ISO with offset — sliced for date/time, never
 * round-tripped through Date, so renderings show wall-clock time.
 */
import { deviceTz, toLocalIso } from '../contract/time'

export interface DigestItem {
  /** Local ISO with offset (entry.capturedAt). */
  capturedAt: string
  place?: string
  /** Transcript + note texts, in display order. */
  texts: string[]
  audioCount: number
  photoCount: number
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

/**
 * The system prompt: role + data model + tool usage + current time. The
 * time is truncated to the hour so the prompt — the very start of the token
 * stream — stays byte-identical across turns and tool-loop steps, keeping
 * the server's prefix (KV) cache valid instead of re-prefilling the whole
 * conversation every request.
 */
export function buildInstructions(now: Date = new Date()): string {
  return [
    'You are the assistant inside Timebox, a personal time and location log.',
    'The user records entries through the day: voice notes (transcribed), typed notes, and photos; each entry carries a local capture time and sometimes a place label.',
    'Answer questions about their log: what they did, when, where, patterns and summaries.',
    'You have read-only tools over the log. Use list_entries for date ranges ("today", "this week", summaries), search_entries for keyword lookups across the whole log, and get_places for the user\u2019s saved places.',
    'Ground answers in tool results; if the log does not contain the answer, say so instead of guessing.',
    'Tool results use the user\u2019s local wall-clock time, grouped by day: "- HH:MM [@ place] \u2014 entry text [media]".',
    'Be concise and concrete.',
    '',
    `Current local time: ${toLocalIso(now).slice(0, 13)}:00 (${deviceTz()}).`,
  ].join('\n')
}
