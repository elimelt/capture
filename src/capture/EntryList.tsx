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

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
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
        />
      ))}
    </div>
  )
}
