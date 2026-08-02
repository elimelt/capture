/**
 * Client for the transcription service (Speaches / OpenAI-compatible
 * Whisper at transcribe.elimelt.com). Accepts the recorder's blob as-is —
 * the server decodes audio/mp4 (iOS) and audio/webm alike.
 *
 * Transcription streams: with `stream=true` the server sends one SSE event
 * per whisper segment (`response_format=text`, so each payload is the raw
 * segment text). Partial transcripts are surfaced through `onPartial` for
 * live UI; the resolved value is the full transcript, byte-identical to
 * what the non-streaming endpoint would have returned (see stream.ts).
 */
import { assembleTranscript, feedSse } from './stream'

const BASE_URL = 'https://transcribe.elimelt.com'
const MODEL = 'Systran/faster-whisper-base.en'
const TIMEOUT_MS = 60_000

/** Server sniffs content, but a sensible filename extension helps. */
function fileName(mimeType: string): string {
  if (mimeType.startsWith('audio/mp4')) return 'clip.m4a'
  if (mimeType.startsWith('audio/webm')) return 'clip.webm'
  return 'clip.audio'
}

/**
 * Returns the transcript text (may be empty for silent clips). While the
 * response streams, `onPartial` receives the transcript-so-far after each
 * segment — display-only; callers must persist nothing until the promise
 * resolves (a mid-stream failure rejects, and partial text is not a result).
 */
export async function transcribeAudio(
  blob: Blob,
  mimeType: string,
  onPartial?: (text: string) => void,
): Promise<string> {
  const form = new FormData()
  form.set('model', MODEL)
  form.set('response_format', 'text')
  form.set('stream', 'true')
  // Trim leading/trailing silence server-side; base.en hallucinates on it.
  form.set('vad_filter', 'true')
  form.set('file', new File([blob], fileName(mimeType), { type: mimeType }))

  const res = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status}`)

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    // Server ignored `stream` — fall back to the whole plain-text body.
    return (await res.text()).trim()
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const segments: string[] = []
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const fed = feedSse(buffer, value)
      buffer = fed.buffer
      if (fed.data.length > 0) {
        segments.push(...fed.data)
        onPartial?.(assembleTranscript(segments))
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  // The server terminates every event with a blank line, so leftover text
  // means the stream was cut mid-segment: fail (transient) rather than
  // resolve with a silently truncated transcript.
  if (buffer.trim() !== '') throw new Error('transcription failed: truncated stream')
  return assembleTranscript(segments)
}
