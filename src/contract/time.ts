/** Local-time ISO-8601 helpers. All contract timestamps carry the local offset. */

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0')
}

/** Format a Date as ISO-8601 in the device's local zone, e.g. "2026-08-02T09:04:11-04:00". */
export function toLocalIso(date: Date): string {
  const offMin = -date.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const offset = `${sign}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    offset
  )
}

/** Local calendar date ("YYYY-MM-DD") of a local-offset ISO string. */
export function localDateOf(iso: string): string {
  return iso.slice(0, 10)
}

/** Add minutes to a local-offset ISO string, preserving the original offset. */
export function addMinutesIso(iso: string, minutes: number): string {
  const offset = iso.slice(19) // "±HH:MM" or "Z"
  const base = new Date(iso)
  const shifted = new Date(base.getTime() + minutes * 60_000)
  if (offset === 'Z' || offset === '') return shifted.toISOString().slice(0, 19) + 'Z'
  const sign = offset.startsWith('-') ? -1 : 1
  const [h, m] = offset.slice(1).split(':').map(Number)
  const offMin = sign * (h * 60 + m)
  // Render the shifted instant in the original offset's wall time.
  const wall = new Date(shifted.getTime() + offMin * 60_000)
  return (
    wall.toISOString().slice(0, 19).replace('Z', '') + offset
  )
}

export function deviceTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
