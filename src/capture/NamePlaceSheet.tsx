import { useState } from 'react'
import { Button, FieldRow, Sheet, TextInput, commitNumericDraft, cx, tone, type_ } from '../ui'
import { DEFAULT_PLACE_RADIUS_M } from './geo'

interface NamePlaceSheetProps {
  /** Optional "near …" hint shown under the title while the user names it. */
  address?: string
  onSave: (name: string, radiusM: number) => void
  onClose: () => void
}

/**
 * Prompt shown after capturing at a location the user has never named. Naming
 * it saves a Place (so future captures auto-label) and retro-labels the just
 * captured entry. Skipping is always fine — capture never dead-ends (§4.1).
 */
export function NamePlaceSheet({ address, onSave, onClose }: NamePlaceSheetProps) {
  const [name, setName] = useState('')
  // String-backed so the field can be momentarily empty while editing without
  // snapping back to a default; validated and clamped only on save, and Save
  // stays disabled while the draft is empty or invalid.
  const [radius, setRadius] = useState(String(DEFAULT_PLACE_RADIUS_M))

  const radiusM = commitNumericDraft(radius, 10)

  return (
    <Sheet title="Name this place" onClose={onClose}>
      {address && <p className={cx('mb-3 -mt-1', type_.caption, tone.textMuted)}>near {address}</p>}
      <TextInput
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Home, Office, Gym…"
        className="w-full"
      />
      <FieldRow label="Radius (m)">
        <TextInput
          type="number"
          min={10}
          inputMode="numeric"
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          className="w-24 text-right"
        />
      </FieldRow>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Skip
        </Button>
        <Button
          variant="primary"
          block
          disabled={!name.trim() || radiusM === undefined}
          onClick={() => {
            const trimmed = name.trim()
            if (trimmed && radiusM !== undefined) onSave(trimmed, radiusM)
            onClose()
          }}
        >
          Save place
        </Button>
      </div>
    </Sheet>
  )
}
