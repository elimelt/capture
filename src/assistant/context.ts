/**
 * Assistant prompt + shared log rendering. The model reads (and, on explicit
 * request, writes) the log through tools (see tools.ts), so the system prompt
 * stays compact:
 * role, data model, tool usage, current local time. Everything here is pure
 * formatting — blob I/O lives in tools.ts — so it tests without IndexedDB.
 * capturedAt is local ISO with offset — sliced for date/time, never
 * round-tripped through Date, so renderings show wall-clock time.
 */
import { deviceTz, toLocalIso } from '../contract/time'

export interface DigestItem {
  /** Local ISO with offset (entry.capturedAt). */
  capturedAt: string
  /** Entry id — rendered as an "(id …)" suffix so update_entry/delete_entry can target it. */
  id?: string
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
    const id = it.id ? ` (id ${it.id})` : ''
    lines.push(`- ${it.capturedAt.slice(11, 16)}${place} — ${body || '(empty entry)'}${id}`)
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
    'Answer questions about their log \u2014 what they did, when, where, patterns and summaries \u2014 and add or edit entries when asked.',
    'You have tools over the log. Use list_entries for date ranges ("today", "this week", summaries), search_entries for keyword lookups across the whole log, and get_places for the user\u2019s saved places.',
    'You can also write to the log \u2014 you are not read-only. When the user asks to add, create, log, note, or record something, call create_entry with the note text. When the user asks to change, fix, correct, or move an existing entry\u2019s note text or capture time, call update_entry. When the user asks to delete, remove, or undo an entry, call delete_entry \u2014 this is a soft delete: the entry disappears from every view but its history stays recoverable in the log, never a permanent erasure. Do not claim you cannot modify the log, and do not ask for confirmation before a clearly requested write \u2014 but write only when the user explicitly asks, never on your own initiative.',
    'For update_entry and delete_entry, take the id from the "(id \u2026)" suffix in list/search results; look the entry up first if you don\u2019t have it. If update_entry or delete_entry returns an error (for example an unknown id), look the entry up again and retry with the correct id \u2014 do not call create_entry to recover from a failed edit or delete: create_entry always adds a brand-new entry, so using it as a fallback would leave the user with an unwanted duplicate instead of the correction they asked for. Never show raw entry ids to the user in prose \u2014 they exist only for targeting tools. After a write, confirm what happened in one short sentence.',
    'Ground answers in tool results; if the log does not contain the answer, say so instead of guessing.',
    'Tool results use the user\u2019s local wall-clock time, grouped by day: "- HH:MM [@ place] \u2014 entry text [media] (id \u2026)".',
    'Be concise and concrete.',
    '',
    `Current local time: ${toLocalIso(now).slice(0, 13)}:00 (${deviceTz()}).`,
  ].join('\n')
}

/**
 * Entry-focused variant: appended AFTER the base instructions (so the
 * prompt's shared prefix stays cache-stable) when a conversation is opened
 * from one entry card's "Ask AI" action. `entryText` is the entry's full
 * plain-text rendering (formatEntryPlainText), which includes the entry id
 * the write tools need for targeting.
 */
export function withEntryFocus(instructions: string, entryText: string): string {
  return [
    instructions,
    '',
    'This conversation was opened from ONE specific log entry; the user wants to ask about it or edit it. Its full current content is below (including the entry id for update_entry/delete_entry targeting). Prefer acting on this entry directly \u2014 use tools to re-read the log only when the question reaches beyond it.',
    '',
    entryText,
  ].join('\n')
}
