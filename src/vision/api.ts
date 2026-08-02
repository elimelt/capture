/**
 * Client for photo captioning: gemma4:e4b on the LLM host, via its native
 * (Ollama-style) /api/chat endpoint rather than the OpenAI-compat /v1 —
 * only the native API honors `think: false`, which turns a ~20s reasoning
 * detour into a ~2-3s caption. CORS is origin-gated like /v1; no API key.
 */

const CHAT_URL = 'https://llm.elimelt.com/api/chat'
const MODEL = 'gemma4:e4b'
const TIMEOUT_MS = 60_000

/** Long edge of the downscaled upload; gemma's vision tower sees ~896px. */
const MAX_EDGE_PX = 1024
const JPEG_QUALITY = 0.8

const PROMPT =
  'This photo is an entry in a personal time-tracking journal. ' +
  'Caption it in one or two short sentences: the main subject, any readable text, ' +
  'and the setting or activity. Reply with the caption only.'

/**
 * Downscale + re-encode to JPEG so uploads stay ~100KB instead of the
 * multi-megabyte camera original (which iOS hands us as JPEG/HEIC).
 */
async function toJpegBase64(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('caption failed: no 2d canvas context')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('caption failed: JPEG encode'))),
        'image/jpeg',
        JPEG_QUALITY,
      )
    })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(jpeg)
    })
    return dataUrl.slice(dataUrl.indexOf(',') + 1)
  } finally {
    bitmap.close()
  }
}

/** Returns the caption text (may be empty if the model produced none). */
export async function captionPhoto(blob: Blob): Promise<string> {
  const image = await toJpegBase64(blob)
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      think: false,
      stream: false,
      messages: [{ role: 'user', content: PROMPT, images: [image] }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`caption failed: HTTP ${res.status}`)
  const data = (await res.json()) as { message?: { content?: unknown } }
  const content = data.message?.content
  if (typeof content !== 'string') throw new Error('caption failed: no content in response')
  return content.trim()
}
