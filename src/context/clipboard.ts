function isStandalonePwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function copyFromSelection(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  document.body.append(area)
  try {
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    area.remove()
  }
}

/** Local clipboard helper. The standalone-PWA path stays synchronous. */
export async function copyPlainText(text: string): Promise<void> {
  // iOS exposes navigator.clipboard in Home Screen apps but rejects its
  // promise. Waiting for that rejection would consume the tap activation
  // needed by execCommand, so use the synchronous selection path first.
  if (isStandalonePwa()) {
    copyFromSelection(text)
    return
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Safari may expose the API but reject it in an installed-PWA context.
    }
  }
  copyFromSelection(text)
}
