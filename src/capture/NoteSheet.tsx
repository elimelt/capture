import { useState } from 'react'

interface NoteSheetProps {
  onSave: (text: string) => void
  onClose: () => void
}

export function NoteSheet({ onSave, onClose }: NoteSheetProps) {
  const [text, setText] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-white p-4 pb-8 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          Add note
        </h2>
        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base text-slate-900 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          placeholder="Type a note…"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={onClose}
            className="min-h-11 flex-1 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const trimmed = text.trim()
              if (trimmed) onSave(trimmed)
              onClose()
            }}
            className="min-h-11 flex-1 rounded-lg bg-sky-600 text-sm font-medium text-white disabled:opacity-50"
            disabled={!text.trim()}
          >
            Save note
          </button>
        </div>
      </div>
    </div>
  )
}
