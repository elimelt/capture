/**
 * B9: delete hides the entry at once; the revoke is appended when the undo
 * window closes (or on unmount), so undo needs no un-revoke in the contract.
 */
import { useEffect, useRef, useState } from 'react'

export function usePendingDelete(revoke: (ids: string[]) => Promise<void>): {
  /** Entry hidden from the list while the undo window is open. */
  pendingId: string | null
  /** Hide the entry and arm the 5s commit timer. */
  request: (id: string) => void
  undo: () => void
  /** Deleted-toast visibility. */
  toastOpen: boolean
} {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [toastOpen, setToastOpen] = useState(false)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const revokeRef = useRef(revoke)
  revokeRef.current = revoke

  function commit() {
    const id = pendingRef.current
    if (id) {
      pendingRef.current = null
      setPendingId(null)
      void revokeRef.current([id])
    }
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(
    () => () => {
      clearTimeout(timerRef.current)
      commitRef.current()
    },
    [],
  )

  function request(id: string) {
    commitRef.current() // only one pending delete at a time
    clearTimeout(timerRef.current)
    pendingRef.current = id
    setPendingId(id)
    setToastOpen(true)
    timerRef.current = setTimeout(() => {
      setToastOpen(false)
      commitRef.current()
    }, 5000)
  }

  function undo() {
    clearTimeout(timerRef.current)
    pendingRef.current = null
    setPendingId(null)
    setToastOpen(false)
  }

  return { pendingId, request, undo, toastOpen }
}
