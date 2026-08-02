/**
 * Per-entry edit sheet (SPEC §4.1): the one place every envelope field of an
 * entry is editable — capture date, time of day, and which attachments the
 * entry keeps. Removals are staged locally and committed with the date/time
 * change as ONE amend event on Save (append-only: the log keeps the removed
 * files and full history; the fold just stops showing them). Note/transcript
 * text stays editable inline on the card; location has its own map sheet.
 */
import { useEffect, useState } from 'react'
import type { AmendPatch, Attachment, Entry } from '../contract/types'
import { localDateOf, toLocalIso } from '../contract/time'
import { getBlob } from '../store/events'
import { Button, FieldRow, Sheet, TextInput, cx, tone, type_ } from '../ui'
import { isCaption } from '../vision/plan'
import { draftFromEntry, draftPatch, toggleRemoval } from './editPlan'

interface EditEntrySheetProps {
  entry: Entry
  /** One amend patch for the whole edit; never called for a no-op. */
  onSave: (patch: AmendPatch) => void
  onClose: () => void
}

export function EditEntrySheet({ entry, onSave, onClose }: EditEntrySheetProps) {
  const [draft, setDraft] = useState(() => draftFromEntry(entry))
  const patch = draftPatch(entry, draft)

  return (
    <Sheet title="Edit entry" onClose={onClose}>
      <div className="flex flex-col gap-1">
        <FieldRow label="Date">
          <TextInput
            type="date"
            value={draft.date}
            max={localDateOf(toLocalIso(new Date()))}
            onChange={(e) => {
              if (e.target.value) setDraft({ ...draft, date: e.target.value })
            }}
            aria-label="Capture date"
          />
        </FieldRow>
        <FieldRow label="Time">
          <TextInput
            type="time"
            value={draft.time}
            onChange={(e) => {
              if (e.target.value) setDraft({ ...draft, time: e.target.value })
            }}
            aria-label="Capture time"
          />
        </FieldRow>
      </div>

      {entry.attachments.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <span className={cx(type_.caption, tone.textFaint)}>Attachments</span>
          {entry.attachments.map((a) => (
            <AttachmentRow
              key={a.file}
              attachment={a}
              removed={draft.removeFiles.includes(a.file)}
              onToggle={() => setDraft(toggleRemoval(draft, a.file))}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          block
          disabled={patch === null}
          onClick={() => {
            if (patch) onSave(patch)
            onClose()
          }}
        >
          Save
        </Button>
      </div>
    </Sheet>
  )
}

function attachmentLabel(a: Attachment): string {
  if (a.kind === 'audio') {
    return a.durationSec !== undefined ? `Recording · ${a.durationSec}s` : 'Recording'
  }
  if (a.kind === 'photo') return 'Photo'
  if (a.derivedFrom === undefined) return 'Note'
  return isCaption(a) ? 'Caption' : 'Transcript'
}

/**
 * One attachment with a Remove/Restore toggle. Text kinds load a one-line
 * preview and photos a thumbnail (both from the local blob store) so multiple
 * attachments of the same kind are tellable apart. Staged removals stay
 * visible, struck through, until Save commits them.
 */
function AttachmentRow({
  attachment,
  removed,
  onToggle,
}: {
  attachment: Attachment
  removed: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      {attachment.kind === 'photo' && <PhotoPreview file={attachment.file} />}
      <div className={cx('min-w-0 flex-1', removed && 'line-through opacity-50')}>
        <span className={cx('block truncate', type_.ui, tone.textSecondary)}>
          {attachmentLabel(attachment)}
        </span>
        {attachment.kind === 'text' && <TextPreview file={attachment.file} />}
      </div>
      <Button variant={removed ? 'secondary' : 'dangerGhost'} size="sm" onClick={onToggle}>
        {removed ? 'Restore' : 'Remove'}
      </Button>
    </div>
  )
}

function TextPreview({ file }: { file: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void getBlob(file).then(async (blob) => {
      if (blob && !stale) setText(await blob.text())
    })
    return () => {
      stale = true
    }
  }, [file])
  if (text === null) return null
  return <span className={cx('block truncate', type_.caption, tone.textFaint)}>{text}</span>
}

function PhotoPreview({ file }: { file: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let stale = false
    void getBlob(file).then((blob) => {
      if (blob && !stale) {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }
    })
    return () => {
      stale = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file])
  if (!url) return null
  return (
    <img src={url} alt="" className={cx('h-9 w-9 rounded-lg border object-cover', tone.border)} />
  )
}
