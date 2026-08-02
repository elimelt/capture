import { useState } from 'react'
import { Button, Sheet, TextArea } from '../ui'

interface TextSheetProps {
  title: string
  placeholder: string
  cta: string
  onSave: (text: string) => void
  onClose: () => void
}

/** Bottom-sheet text entry: used for "+ note" and the type-instead capture (A3). */
export function TextSheet({ title, placeholder, cta, onSave, onClose }: TextSheetProps) {
  const [text, setText] = useState('')

  return (
    <Sheet title={title} onClose={onClose}>
      <TextArea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
      />
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          block
          disabled={!text.trim()}
          onClick={() => {
            const trimmed = text.trim()
            if (trimmed) onSave(trimmed)
            onClose()
          }}
        >
          {cta}
        </Button>
      </div>
    </Sheet>
  )
}
