import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx, layer, motion, tone, type_ } from './tokens'

/**
 * Mounts a fullscreen layer (sheet, scrim, viewer) at document.body.
 * Required for anything on `layer.overlay`: entrance animations run with
 * fill `both`, so screen roots and cards stay stacking contexts forever —
 * an overlay rendered in place would paint beneath the fixed tab bar
 * (later in DOM order) regardless of its z-index. Portaling out means no
 * ancestor stacking context can trap it. React events still bubble through
 * the component tree, so handlers behave as if rendered in place.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

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

/**
 * Freeze the page behind a fullscreen overlay while mounted: iOS scrolls
 * the body through fixed overlays, so touches on the overlay would move
 * the screen underneath. position:fixed (not overflow:hidden, which iOS
 * ignores) keeps the page pinned; restores the scroll position on unmount.
 */
export function useBodyScrollLock(): void {
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
}

interface SheetProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** Bottom sheet: backdrop tap closes, content lifts above the keyboard. */
export function Sheet({ title, onClose, children }: SheetProps) {
  const keyboardInset = useKeyboardInset()
  useBodyScrollLock()

  // Portaled so the backdrop provably covers (and blocks taps on) the tab
  // bar: rendered in place, a screen/card stacking context would trap the
  // sheet beneath it. See OverlayPortal.
  return (
    <OverlayPortal>
      <div
        className={cx('fixed inset-0 flex items-end bg-black/40', layer.overlay, motion.fadeIn)}
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
    </OverlayPortal>
  )
}
