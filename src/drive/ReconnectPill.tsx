/**
 * Passive "Reconnect Google" pill (SPEC §8.2). Never a blocking modal: it only
 * appears when the stored Drive token has expired, and renewal happens from an
 * explicit tap (required by the GIS token model, §8.3). Connected/disconnected
 * states show nothing here — connecting for the first time lives in Settings.
 */
import { useAppStore } from '../store/appStore'
import { cx, tone, type_ } from '../ui'

export function ReconnectPill() {
  const connection = useAppStore((s) => s.driveConnection)
  const syncing = useAppStore((s) => s.syncing)
  const connectDrive = useAppStore((s) => s.connectDrive)
  if (connection !== 'expired') return null

  return (
    <div className="px-4 pt-2">
      <button
        onClick={() => void connectDrive()}
        disabled={syncing}
        className={cx(
          'flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 transition-colors disabled:opacity-50',
          tone.borderStrong,
          tone.textSecondary,
          tone.pressWash,
          type_.sub,
          'font-medium',
        )}
      >
        <span aria-hidden>↻</span>
        {syncing ? 'Reconnecting…' : 'Reconnect Google to sync'}
      </button>
    </div>
  )
}
