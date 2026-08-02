/**
 * Pure streaming core for captioning: incremental NDJSON parsing and delta
 * accumulation, no I/O. Ollama's native /api/chat streams one JSON object
 * per line — `{ message: { content: "<delta>" }, done: false }` per token
 * batch, then a final `{ done: true }` stats line. Concatenating the deltas
 * yields exactly the `message.content` a non-streaming call would return,
 * so the trimmed final caption is identical either way.
 */

export interface LineFeedResult {
  /** Unconsumed tail (a partial line) to pass into the next feed. */
  buffer: string
  /** Complete non-empty lines finished by this chunk, in order. */
  lines: string[]
}

/** Split a decoded chunk into complete lines, buffering any partial tail. */
export function feedLines(buffer: string, chunk: string): LineFeedResult {
  const parts = (buffer + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return {
    buffer: rest,
    lines: parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l !== ''),
  }
}

export interface ChatChunk {
  /** This chunk's `message.content` delta (may be empty on the done line). */
  delta: string
  /** True on the terminal stats line — the caption is complete. */
  done: boolean
}

/**
 * Parse one NDJSON line of an /api/chat stream. Throws on malformed lines
 * — a server-reported `error` field, unparsable JSON, or a non-terminal
 * chunk without string content — so a broken stream fails the whole attempt
 * instead of quietly truncating the caption.
 */
export function parseChatLine(line: string): ChatChunk {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('caption failed: malformed stream chunk')
  }
  const obj = parsed as { error?: unknown; done?: unknown; message?: { content?: unknown } }
  if (typeof obj.error === 'string') throw new Error(`caption failed: ${obj.error}`)
  const done = obj.done === true
  const content = obj.message?.content
  if (typeof content !== 'string') {
    if (done) return { delta: '', done }
    throw new Error('caption failed: no content in response')
  }
  return { delta: content, done }
}

/**
 * Final caption from the accumulated deltas: plain concatenation, then trim
 * — identical to trimming the non-streaming `message.content`. Also used
 * for the partial text shown mid-stream.
 */
export function assembleCaption(deltas: readonly string[]): string {
  return deltas.join('').trim()
}
