/**
 * Pure streaming core for transcription: incremental SSE parsing and
 * transcript assembly, no I/O. Speaches streams `response_format=text`
 * segments as one SSE event per segment, each `data:` payload carrying the
 * segment's *raw* text (leading space and all, since SSE strips exactly one
 * space after the colon). Concatenating the raw payloads and trimming
 * reproduces the server's own non-streaming join byte-for-byte
 * (`"".join(segment.text).strip()` in speaches' text_utils), which is the
 * invariant the runner persists against.
 */

export interface SseFeedResult {
  /** Unconsumed tail (a partial event) to pass into the next feed. */
  buffer: string
  /** `data:` payloads of the events completed by this chunk, in order. */
  data: string[]
}

/**
 * Feed one decoded chunk of an SSE body. Events are terminated by a blank
 * line; a chunk may end mid-event, so the leftover text is returned as the
 * next call's buffer. Within an event, only `data:` lines contribute
 * (multiple join with "\n" per the SSE spec); exactly one leading space
 * after the colon is stripped, preserving the rest of the payload verbatim.
 */
export function feedSse(buffer: string, chunk: string): SseFeedResult {
  let text = buffer + chunk
  // Hold back a trailing CR: it may be half of a CRLF split across chunks.
  let held = ''
  if (text.endsWith('\r')) {
    held = '\r'
    text = text.slice(0, -1)
  }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = text.split('\n\n')
  const rest = blocks.pop() ?? ''
  const data: string[] = []
  for (const block of blocks) {
    const payload = eventData(block)
    if (payload !== null) data.push(payload)
  }
  return { buffer: rest + held, data }
}

/** The joined `data:` payload of one event block, or null if it has none. */
function eventData(block: string): string | null {
  const parts: string[] = []
  for (const line of block.split('\n')) {
    if (line === 'data') {
      parts.push('')
    } else if (line.startsWith('data:')) {
      let payload = line.slice('data:'.length)
      if (payload.startsWith(' ')) payload = payload.slice(1)
      parts.push(payload)
    }
    // Other fields (event:, id:, retry:) and comments are ignored.
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Final transcript from the raw segment payloads: plain concatenation, then
 * trim — identical to the text the non-streaming endpoint would return.
 * Also used for the partial text shown mid-stream, so partial and final
 * rendering agree at every prefix.
 */
export function assembleTranscript(segments: readonly string[]): string {
  return segments.join('').trim()
}
