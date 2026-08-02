import type { Entry } from '../contract/types'
import { useAppStore } from '../store/appStore'
import { withTimeOfDayIso } from '../contract/time'
import { EntryCard } from './EntryCard'

interface EntryListProps {
  entries: Entry[]
  /**
   * Delete requests bubble up (B9): the screen hides the entry at once and
   * appends the revoke only after the undo window, so delete is undoable
   * without needing un-revoke in the contract.
   */
  onDelete: (entryId: string) => void
}

export function EntryList({ entries, onDelete }: EntryListProps) {
  const amend = useAppStore((s) => s.amend)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const syncStatuses = useAppStore((s) => s.syncStatuses)

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          maxClipSec={streamSettings.maxClipSec}
          syncStatus={syncStatuses.get(entry.id)?.status}
          onDelete={() => onDelete(entry.id)}
          onSetTime={(time) =>
            void amend({
              targets: [entry.id],
              patch: { capturedAt: withTimeOfDayIso(entry.capturedAt, time) },
            })
          }
          onAddNote={(text) =>
            void amend({
              targets: [entry.id],
              attachments: [
                { kind: 'text', blob: new Blob([text], { type: 'text/plain' }), mimeType: 'text/plain' },
              ],
            })
          }
          onAddPhoto={(file) =>
            void amend({
              targets: [entry.id],
              attachments: [
                { kind: 'photo', blob: file, mimeType: file.type || 'image/jpeg' },
              ],
            })
          }
          onAddAudio={(result) =>
            void amend({
              targets: [entry.id],
              attachments: [
                {
                  kind: 'audio',
                  blob: result.blob,
                  mimeType: result.mimeType,
                  durationSec: result.durationSec,
                },
              ],
            })
          }
          onEditText={(oldFile, text, derivedFrom) =>
            void amend({
              targets: [entry.id],
              patch: { removeAttachments: [oldFile] },
              attachments: [
                {
                  kind: 'text',
                  blob: new Blob([text], { type: 'text/plain' }),
                  mimeType: 'text/plain',
                  // Edited transcripts stay derived: never re-transcribed.
                  ...(derivedFrom !== undefined ? { derivedFrom } : {}),
                },
              ],
            })
          }
          onRemoveAttachment={(file) =>
            void amend({
              targets: [entry.id],
              patch: { removeAttachments: [file] },
            })
          }
          onSetLocation={(location) =>
            void amend({
              targets: [entry.id],
              // A null clears the location via the append-only clearLocation
              // flag; the fold treats an absent `location` as "no change".
              patch: location ? { location } : { clearLocation: true },
            })
          }
        />
      ))}
    </div>
  )
}
