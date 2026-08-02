/**
 * Edit sheet for one calendar pseudo-entry (SPEC §3.6, §4.2). A separate
 * component from capture's EditEntrySheet — the field sets diverge (title/
 * note/start/end here; date/time/attachments there) — but the same pattern:
 * hold a draft, diff on Save, emit ONE event. The diffing is the pure core's
 * `overlayPatchFromDraft`: `undefined` means nothing changed, so Save stays
 * disabled and closing the sheet never writes — an unedited calendar event
 * never materializes an overlay (the copy-on-write no-op guard). Editing an
 * emptied title/note maps to `clearTitle`/`clearNote` in the core (revert to
 * the live event / drop the note). Edits are app-local annotations; the
 * "Open in Google Calendar" link is the only way to change the real event.
 */
import { useState } from 'react'
import { toLocalIso } from '../contract/time'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'
import { draftFromPseudoEntry, overlayPatchFromDraft } from '../gcal/overlay/overlayPlan'
import type { OverlayPatch } from '../gcal/overlay/types'
import { Button, FieldRow, Sheet, TextArea, TextInput, cx, tone, type_ } from '../ui'

/** Local-offset ISO → the "YYYY-MM-DDTHH:mm" a datetime-local input renders. */
function isoToInput(iso: string): string {
  return iso.slice(0, 16)
}

interface EditPseudoEntrySheetProps {
  entry: PseudoEntry
  /** One overlay event per save; never called for a no-op edit. */
  onSave: (patch: OverlayPatch) => void
  onClose: () => void
}

export function EditPseudoEntrySheet({ entry, onSave, onClose }: EditPseudoEntrySheetProps) {
  // The original is frozen at open so the diff is against what the sheet
  // showed; only fields the user actually changed enter draft (and thus the
  // patch), keeping untouched fields tracking the live calendar event.
  const [original] = useState(() => draftFromPseudoEntry(entry))
  const [draft, setDraft] = useState(original)
  const patch = overlayPatchFromDraft(original, draft)

  return (
    <Sheet title="Edit calendar event" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className={cx(type_.caption, tone.textFaint)}>Title</span>
          <TextInput
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-label="Event title"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className={cx(type_.caption, tone.textFaint)}>Note</span>
          <TextArea
            rows={2}
            value={draft.note}
            placeholder="Add a note…"
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            aria-label="Event note"
          />
        </div>

        <div className="flex flex-col gap-1">
          <FieldRow label="Starts">
            <TextInput
              type="datetime-local"
              value={isoToInput(draft.startAt)}
              onChange={(e) => {
                if (e.target.value) setDraft({ ...draft, startAt: toLocalIso(new Date(e.target.value)) })
              }}
              aria-label="Event start"
            />
          </FieldRow>
          <FieldRow label="Ends">
            <TextInput
              type="datetime-local"
              value={isoToInput(draft.endAt)}
              onChange={(e) => {
                if (e.target.value) setDraft({ ...draft, endAt: toLocalIso(new Date(e.target.value)) })
              }}
              aria-label="Event end"
            />
          </FieldRow>
        </div>

        <p className={cx(type_.caption, tone.textFaint)}>
          Edits stay in this app — the Google Calendar event is never changed.
          {entry.htmlLink !== undefined && (
            <>
              {' '}
              <a
                href={entry.htmlLink}
                target="_blank"
                rel="noreferrer"
                className={cx('font-medium underline underline-offset-2', tone.accent)}
              >
                Open in Google Calendar
              </a>
            </>
          )}
        </p>
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          block
          disabled={patch === undefined}
          onClick={() => {
            if (patch !== undefined) onSave(patch)
            onClose()
          }}
        >
          Save
        </Button>
      </div>
    </Sheet>
  )
}
