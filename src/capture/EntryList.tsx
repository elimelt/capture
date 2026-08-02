import type { Entry } from '../contract/types'
import type { SyncStatusRow } from '../store/db'
import { useAppStore } from '../store/appStore'
import { addMinutesIso, toLocalIso } from '../contract/time'
import { EntryCard } from './EntryCard'

interface EntryListProps {
  entries: Entry[]
  syncStatuses: Map<number, SyncStatusRow>
}

export function EntryList({ entries, syncStatuses }: EntryListProps) {
  const revoke = useAppStore((s) => s.revoke)
  const amend = useAppStore((s) => s.amend)

  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        No entries yet today.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          status={syncStatuses.get(entry.seq)?.status ?? 'queued'}
          onDelete={() => void revoke([entry.id])}
          onShiftTime={(mode) => {
            const capturedAt =
              mode === 'now'
                ? toLocalIso(new Date())
                : addMinutesIso(entry.capturedAt, mode === '-5' ? -5 : -1)
            void amend({ targets: [entry.id], patch: { capturedAt } })
          }}
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
