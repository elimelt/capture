/** Short event ids: 6 chars, base36, crypto-random. Unique enough per stream. */
export function newEventId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}
