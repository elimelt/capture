import { useEffect, useState, type ReactNode } from 'react'
import { cx, motion, tone, type_ } from './tokens'

/**
 * Height of the iOS software keyboard overlapping the layout viewport, so
 * bottom sheets and fixed composers can lift their content above it (C12).
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}

interface SheetProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** Bottom sheet: backdrop tap closes, content lifts above the keyboard. */
export function Sheet({ title, onClose, children }: SheetProps) {
  const keyboardInset = useKeyboardInset()

  // Freeze the page behind the sheet: iOS scrolls the body through fixed
  // overlays, so touches on the sheet would move the screen underneath.
  // position:fixed (not overflow:hidden, which iOS ignores) keeps the page
  // pinned; restore the scroll position on close.
  useEffect(() => {
    const { scrollY } = window
    const body = document.body
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    return () => {
      body.style.position = ''
      body.style.top = ''
      body.style.width = ''
      window.scrollTo(0, scrollY)
    }
  }, [])

  return (
    <div
      className={cx('fixed inset-0 z-50 flex items-end bg-black/40', motion.fadeIn)}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cx('w-full rounded-t-3xl p-4', tone.surface, motion.sheetIn)}
        style={{
          paddingBottom: `calc(max(env(safe-area-inset-bottom), 1rem) + ${keyboardInset}px)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cx('mx-auto mb-3 h-1 w-9 rounded-full', tone.sunken)} />
        <h2 className={cx('mb-3', type_.heading, tone.textPrimary)}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
