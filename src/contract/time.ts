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

/** Wall-clock time of day ("HH:mm") of an ISO string in the device's zone. */
export function localTimeOf(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Wall-clock time of day ("HH:mm") as written in the string — the entry's
 * own offset, not the device zone (the counterpart of localDateOf's pure
 * slice). For canonical contract timestamps these civil fields are exactly
 * the wall clock of the entry's `deviceTz` at capture, so pairing this with
 * localDateOf describes one consistent civil instant in the entry's zone.
 */
export function civilTimeOf(iso: string): string {
  return iso.slice(11, 16)
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

/**
 * Set the wall-clock time of day ("HH:mm") on a local-offset ISO string,
 * keeping the date and re-rendering in the device's current zone.
 */
export function withTimeOfDayIso(iso: string, time: string): string {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(iso)
  d.setHours(h, m, 0, 0)
  return toLocalIso(d)
}

/** Offset (minutes east of UTC) of IANA zone `tz` at the given instant. */
function offsetMinutesAt(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUtc - utcMs) / 60_000
}

/**
 * Render civil wall time — `date` "YYYY-MM-DD" + `time` "HH:mm", seconds
 * zeroed — in IANA zone `tz` as a contract ISO string, resolving the zone's
 * offset at that moment (DST-safe: the output's civil fields are exactly the
 * given wall time; only the offset varies). The edit sheet uses this with
 * the entry's own `deviceTz`, so editing preserves the entry's zone instead
 * of silently re-rendering into the device's. A wall time skipped or
 * repeated by a DST transition resolves deterministically (second-pass
 * offset probe).
 */
export function zonedIso(date: string, time: string, tz: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0)
  const guess = offsetMinutesAt(wallAsUtc, tz)
  const offMin = offsetMinutesAt(wallAsUtc - guess * 60_000, tz)
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function deviceTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
