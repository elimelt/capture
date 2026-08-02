import type { Entry } from '../contract/types'
import { useAppStore } from '../store/appStore'
import { withTimeOfDayIso } from '../contract/time'
import { EntryCard } from './EntryCard'
import { downscalePhoto } from './photo'

interface EntryListProps {
  entries: Entry[]
  /**
   * Delete requests bubble up (B9): the screen hides the entry at once and
   * appends the revoke only after the undo window, so delete is undoable
   * without needing un-revoke in the contract.
   */
  onDelete: (entryId: string) => void
  /** Request a plain-text representation of an entry from the parent. */
  onCopy?: (entry: Entry) => void
  /**
   * Timeline-rail continuity (the merged Day view splits its rail into runs of
   * consecutive entries separated by calendar pseudo-entries): whether this
   * run holds the very first / very last node on the whole day's rail, so the
   * connecting line is trimmed only at the rail's true ends, not at every run
   * boundary. Default true/true — a standalone list (the Capture screen) is
   * the entire rail.
   */
  firstOnRail?: boolean
  lastOnRail?: boolean
  /**
   * Newest attachment first within each card — set by the Capture screen,
   * whose list runs newest-first, so a card's sub-timeline reads in the same
   * direction as the list around it. The Day view keeps oldest-first.
   */
  newestFirst?: boolean
}

export function EntryList({
  entries,
  onDelete,
  onCopy,
  firstOnRail = true,
  lastOnRail = true,
  newestFirst = false,
}: EntryListProps) {
  const amend = useAppStore((s) => s.amend)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const syncStatuses = useAppStore((s) => s.syncStatuses)

  return (
    <>
      {entries.map((entry, i) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          maxClipSec={streamSettings.maxClipSec}
          sync={syncStatuses.get(entry.id)}
          first={firstOnRail && i === 0}
          last={lastOnRail && i === entries.length - 1}
          newestFirst={newestFirst}
          onDelete={() => onDelete(entry.id)}
          onCopy={onCopy}
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
            void (async () => {
              const photo = await downscalePhoto(file)
              await amend({
                targets: [entry.id],
                attachments: [{ kind: 'photo', blob: photo.blob, mimeType: photo.mimeType }],
              })
            })()
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
          onApplyEdit={(patch) => void amend({ targets: [entry.id], patch })}
        />
      ))}
    </>
  )
}
