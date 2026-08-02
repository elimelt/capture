import { describe, expect, it } from 'vitest'
import type { Attachment } from '../contract/types'
import { sortAttachmentsByLoggedAt } from './attachmentOrder'

const note = (file: string): Attachment => ({ kind: 'text', file, mimeType: 'text/plain' })

describe('sortAttachmentsByLoggedAt', () => {
  it('orders attachments by their append timestamp and preserves ties', () => {
    const attachments = [note('second'), note('first'), note('same')]
    expect(
      sortAttachmentsByLoggedAt(attachments, {
        first: '2026-08-02T09:00:00-04:00',
        second: '2026-08-02T09:02:00-04:00',
        same: '2026-08-02T09:00:00-04:00',
      }).map((attachment) => attachment.file),
    ).toEqual(['first', 'same', 'second'])
  })

  it('falls back to the entry timestamp for older entries', () => {
    expect(sortAttachmentsByLoggedAt([note('one')], undefined, '2026-08-02T09:00:00-04:00')).toEqual([
      note('one'),
    ])
  })
})
