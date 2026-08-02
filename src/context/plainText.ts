/**
 * Plain-text/Markdown rendering for folded entries (SPEC §3.3).
 *
 * Formatting is pure apart from the explicitly injected text-blob reader. The
 * source attachment is resolved from the entry itself so derived text can be
 * labeled as a voice transcript or image description without guessing from
 * filenames or MIME types.
 */
import type { Attachment, Entry } from '../contract/types'

export type GetBlob = (file: string) => Promise<Blob | undefined>

function escapeLabel(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim()
}

function utcOffset(capturedAt: string): string {
  const offset = /(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(capturedAt)
  if (!offset || offset[0] === 'Z') return 'UTC+00:00'
  return `UTC${offset[1] === '+' ? '+' : '-'}${offset[2]}:${offset[3]}`
}

function sourceKind(attachment: Attachment, attachments: readonly Attachment[]): string {
  if (attachment.derivedFrom === undefined) return 'Note'
  const source = attachments.find((candidate) => candidate.file === attachment.derivedFrom)
  if (source?.kind === 'audio') return 'Voice transcript'
  if (source?.kind === 'photo') return 'Image description'
  return 'Derived text'
}

function formatLocation(entry: Entry): string | undefined {
  if (!entry.location) return undefined
  const { lat, lng, accuracyM, placeLabel, address } = entry.location
  const label = placeLabel ?? address
  const coordinates = `${lat}, ${lng} (±${accuracyM} m)`
  return label ? `${escapeLabel(label)} — ${coordinates}` : coordinates
}

function formatText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return '    (empty)'
  return trimmed
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n')
}

/** Render one folded entry, reading only its text attachments through getBlob. */
export async function formatEntryPlainText(entry: Entry, getBlob: GetBlob): Promise<string> {
  const audio = entry.attachments.filter((attachment) => attachment.kind === 'audio')
  const photos = entry.attachments.filter((attachment) => attachment.kind === 'photo')
  const totalAudioDuration = audio.reduce(
    (total, attachment) => total + (attachment.durationSec ?? 0),
    0,
  )
  const location = formatLocation(entry)
  const lines = [
    `## ${entry.capturedAt.slice(0, 10)} ${entry.capturedAt.slice(11, 19)}`,
    `- Time zone: ${utcOffset(entry.capturedAt)} · ${escapeLabel(entry.deviceTz)}`,
    `- Entry: ${entry.id}`,
    `- Audio: ${audio.length} recording${audio.length === 1 ? '' : 's'}${
      audio.length > 0 ? ` · ${totalAudioDuration}s total` : ''
    }`,
    `- Photos: ${photos.length}`,
  ]
  if (location) lines.push(`- Location: ${location}`)

  const textAttachments = entry.attachments.filter((attachment) => attachment.kind === 'text')
  for (const attachment of textAttachments) {
    const blob = await getBlob(attachment.file)
    const text = await blob?.text()
    lines.push('', `### ${sourceKind(attachment, entry.attachments)}`, formatText(text ?? '(text unavailable)'))
  }
  return lines.join('\n')
}

/** Render entries in their supplied order, separated by a blank line. */
export async function formatEntriesPlainText(
  entries: readonly Entry[],
  getBlob: GetBlob,
): Promise<string> {
  return (await Promise.all(entries.map((entry) => formatEntryPlainText(entry, getBlob)))).join('\n\n')
}
