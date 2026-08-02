/** Markdown/plaintext export for the Context screen. Pure so clipboard output
 * stays stable and can be checked without a browser or IndexedDB. */

export interface ContextItem {
  capturedAt: string
  place?: string
  texts: string[]
  audioCount: number
  photoCount: number
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatContext(
  items: readonly ContextItem[],
  from: string,
  to: string,
): string {
  const lines = ['# Timebox context', `_${from} → ${to}_`, '']
  if (items.length === 0) return [...lines, 'No entries in this period.'].join('\n')

  let day = ''
  for (const item of [...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    const date = item.capturedAt.slice(0, 10)
    if (date !== day) {
      if (day !== '') lines.push('')
      day = date
      lines.push(`## ${dayLabel(date)}`)
    }

    const details: string[] = []
    if (item.place) details.push(`@ ${item.place}`)
    if (item.audioCount > 0) {
      details.push(`${item.audioCount} audio ${item.audioCount === 1 ? 'recording' : 'recordings'}`)
    }
    if (item.photoCount > 0) {
      details.push(`${item.photoCount} ${item.photoCount === 1 ? 'photo' : 'photos'}`)
    }
    const meta = details.length > 0 ? ` — ${details.join(' · ')}` : ''
    lines.push(`- **${item.capturedAt.slice(11, 16)}**${meta}`)
    for (const text of item.texts) {
      lines.push(`  - ${text.replaceAll('\n', '\n    ')}`)
    }
    if (item.texts.length === 0 && details.length === 0) lines.push('  - _(empty entry)_')
  }
  return lines.join('\n')
}
