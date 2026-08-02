/** Local clipboard helper. Uses a selection fallback for Safari PWAs. */
export async function copyPlainText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Safari may expose the API but reject it in an installed-PWA context.
    }
  }
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
