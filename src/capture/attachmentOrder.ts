import type { Attachment } from '../contract/types'

/**
 * Stable timestamp order for the attachment sub-timeline. `newestFirst`
 * flips the direction (a full reverse, so ties also flip) for the Capture
 * screen's newest-first latest-entry card; the Day view stays oldest-first.
 */
export function sortAttachmentsByLoggedAt(
  attachments: readonly Attachment[],
  attachmentLoggedAt: Readonly<Record<string, string>> | undefined,
  fallbackLoggedAt = '',
  newestFirst = false,
): Attachment[] {
  const ordered = attachments
    .map((attachment, index) => ({
      attachment,
      index,
      timestamp: attachmentLoggedAt?.[attachment.file] ?? fallbackLoggedAt,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.index - b.index)
    .map(({ attachment }) => attachment)
  return newestFirst ? ordered.reverse() : ordered
}
