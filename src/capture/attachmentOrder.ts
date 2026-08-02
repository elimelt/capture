import type { Attachment } from '../contract/types'

/** Stable timestamp order for the attachment sub-timeline. */
export function sortAttachmentsByLoggedAt(
  attachments: readonly Attachment[],
  attachmentLoggedAt: Readonly<Record<string, string>> | undefined,
  fallbackLoggedAt = '',
): Attachment[] {
  return attachments
    .map((attachment, index) => ({
      attachment,
      index,
      timestamp: attachmentLoggedAt?.[attachment.file] ?? fallbackLoggedAt,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.index - b.index)
    .map(({ attachment }) => attachment)
}
