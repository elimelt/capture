/**
 * Client for the transcription service (Speaches / OpenAI-compatible
 * Whisper at transcribe.elimelt.com). Accepts the recorder's blob as-is —
 * the server decodes audio/mp4 (iOS) and audio/webm alike.
 */

const BASE_URL = 'https://transcribe.elimelt.com'
const MODEL = 'Systran/faster-whisper-base.en'
const TIMEOUT_MS = 60_000

/** Server sniffs content, but a sensible filename extension helps. */
function fileName(mimeType: string): string {
  if (mimeType.startsWith('audio/mp4')) return 'clip.m4a'
  if (mimeType.startsWith('audio/webm')) return 'clip.webm'
  return 'clip.audio'
}

/** Returns the transcript text (may be empty for silent clips). */
export async function transcribeAudio(blob: Blob, mimeType: string): Promise<string> {
  const form = new FormData()
  form.set('model', MODEL)
  form.set('response_format', 'json')
  // Trim leading/trailing silence server-side; base.en hallucinates on it.
  form.set('vad_filter', 'true')
  form.set('file', new File([blob], fileName(mimeType), { type: mimeType }))

  const res = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`transcription failed: HTTP ${res.status}`)
  const data = (await res.json()) as { text?: unknown }
  if (typeof data.text !== 'string') throw new Error('transcription failed: no text in response')
  return data.text.trim()
}
