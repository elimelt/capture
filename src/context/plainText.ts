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
  if (!trimmed) return '  > (empty)'
  return trimmed
    .split(/\r?\n/)
    .map((line) => `  > ${line}`)
    .join('\n')
}

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19)
}

function entryZone(entry: Entry): string {
  return `${escapeLabel(entry.deviceTz)} (${utcOffset(entry.capturedAt)})`
}

function sourceTimestamp(
  attachment: Attachment,
  attachments: readonly Attachment[],
  attachmentLoggedAt: Record<string, string> | undefined,
  entryLoggedAt: string,
): string | undefined {
  if (attachment.derivedFrom === undefined) return undefined
  const source = attachments.find((candidate) => candidate.file === attachment.derivedFrom)
  return source === undefined ? undefined : attachmentTimestamp({ attachmentLoggedAt, loggedAt: entryLoggedAt }, source)
}

function attachmentTimestamp(
  entry: Pick<Entry, 'attachmentLoggedAt' | 'loggedAt'>,
  attachment: Attachment,
): string {
  return entry.attachmentLoggedAt?.[attachment.file] ?? entry.loggedAt
}

/** Render one folded entry, reading only its text attachments through getBlob. */
async function formatEntry(
  entry: Entry,
  getBlob: GetBlob,
  includeTimezone: boolean,
): Promise<string> {
  const location = formatLocation(entry)
  const lines = [
    `## ${entry.capturedAt.slice(0, 10)} ${formatTime(entry.capturedAt)} · ${entry.id}${
      includeTimezone ? ` · ${entryZone(entry)}` : ''
    }`,
  ]
  if (location) lines.push(`- Location: ${location}`)

  const ordered = [...entry.attachments].sort((a, b) =>
    attachmentTimestamp(entry, a).localeCompare(attachmentTimestamp(entry, b)),
  )
  for (const attachment of ordered) {
    const timestamp = attachmentTimestamp(entry, attachment)
    if (attachment.kind === 'audio') {
      lines.push(
        `- ${formatTime(timestamp)} · Audio recording${
          attachment.durationSec !== undefined ? ` · ${attachment.durationSec}s` : ''
        }`,
      )
      continue
    }
    if (attachment.kind === 'photo') {
      lines.push(`- ${formatTime(timestamp)} · Photo`)
      continue
    }

    const sourceTime = sourceTimestamp(attachment, entry.attachments, entry.attachmentLoggedAt, entry.loggedAt)
    const sourceSuffix = sourceTime === undefined ? '' : ` · source at ${formatTime(sourceTime)}`
    const blob = await getBlob(attachment.file)
    const text = await blob?.text()
    lines.push(
      `- ${formatTime(timestamp)} · ${sourceKind(attachment, entry.attachments)}${sourceSuffix}`,
      formatText(text ?? '(text unavailable)'),
    )
  }
  return lines.join('\n')
}

/** Render one folded entry, including its local time-zone context. */
export async function formatEntryPlainText(entry: Entry, getBlob: GetBlob): Promise<string> {
  return formatEntry(entry, getBlob, true)
}

/** Render entries in their supplied order, separated by a blank line. */
export async function formatEntriesPlainText(
  entries: readonly Entry[],
  getBlob: GetBlob,
): Promise<string> {
  const zones = new Set(entries.map(entryZone))
  const dates = new Set(entries.map((entry) => entry.capturedAt.slice(0, 10)))
  const context = [
    '# Day export',
    `- Entries: ${entries.length}`,
    dates.size === 1 ? `- Date: ${[...dates][0]}` : `- Dates: ${[...dates].sort().join(' → ')}`,
    ...(zones.size === 1 ? [`- Time zone: ${[...zones][0]}`] : ['- Time zones: recorded per entry']),
    '- Each item below is ordered by its recorded timestamp; attachment timestamps are when they were added.',
  ]
  if (entries.length === 0) return context.join('\n')
  const rendered = await Promise.all(entries.map((entry) => formatEntry(entry, getBlob, zones.size !== 1)))
  return `${context.join('\n')}\n\n${rendered.join('\n\n')}`
}
