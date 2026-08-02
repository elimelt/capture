import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from './api'

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** An SSE body from raw fragments, delivered as the given chunks. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** An SSE body that emits `chunks` then errors, like a dropped connection. */
function brokenSseResponse(chunks: string[]): Response {
  let next = 0
  const stream = new ReadableStream<Uint8Array>({
    // Pull-based so every chunk is delivered before the error propagates.
    pull(controller) {
      if (next < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[next++]))
      else controller.error(new Error('connection lost'))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcribeAudio', () => {
  it('posts a multipart form requesting a streamed text response', async () => {
    const fetchMock = stubFetch(sseResponse(['data: hello world\n\n']))
    const text = await transcribeAudio(new Blob(['audio-bytes']), 'audio/mp4')
    expect(text).toBe('hello world')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/v1\/audio\/transcriptions$/)
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('Systran/faster-whisper-base.en')
    expect(form.get('response_format')).toBe('text')
    expect(form.get('stream')).toBe('true')
    expect(form.get('vad_filter')).toBe('true')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('clip.m4a')
    expect(file.type).toBe('audio/mp4')
  })

  it('concatenates raw segments and trims — identical to the non-streaming join', async () => {
    // Whisper segments carry their own leading spaces; two spaces after
    // "data:" mean the payload starts with one (SSE strips exactly one).
    stubFetch(sseResponse(['data:  I spent the morning\n\n', 'data:  writing docs.\n\n']))
    const text = await transcribeAudio(new Blob(['x']), 'audio/mp4')
    expect(text).toBe('I spent the morning writing docs.')
  })

  it('reports the growing transcript through onPartial, ending at the final text', async () => {
    stubFetch(
      sseResponse(['data:  I spent the ', 'morning\n\ndata:', '  writing docs.\n\n']),
    )
    const partials: string[] = []
    const text = await transcribeAudio(new Blob(['x']), 'audio/mp4', (t) => partials.push(t))
    expect(partials).toEqual(['I spent the morning', 'I spent the morning writing docs.'])
    expect(text).toBe('I spent the morning writing docs.')
  })

  it('returns empty for a stream with no segments (silent clip)', async () => {
    const onPartial = vi.fn()
    stubFetch(sseResponse([]))
    await expect(transcribeAudio(new Blob(['x']), 'audio/mp4', onPartial)).resolves.toBe('')
    expect(onPartial).not.toHaveBeenCalled()
  })

  it('rejects when the stream errors mid-transcript, after partials were emitted', async () => {
    stubFetch(brokenSseResponse(['data: partial words\n\n']))
    const partials: string[] = []
    await expect(
      transcribeAudio(new Blob(['x']), 'audio/mp4', (t) => partials.push(t)),
    ).rejects.toThrow()
    // The partial was surfaced for display but the call still failed — the
    // caller must not persist it.
    expect(partials).toEqual(['partial words'])
  })

  it('rejects when the stream ends mid-event instead of truncating', async () => {
    stubFetch(sseResponse(['data: complete\n\n', 'data: cut off mid-seg']))
    await expect(transcribeAudio(new Blob(['x']), 'audio/mp4')).rejects.toThrow(
      'transcription failed: truncated stream',
    )
  })

  it('falls back to the plain text body when the server does not stream', async () => {
    stubFetch(
      new Response(' hello world \n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
    )
    const onPartial = vi.fn()
    const text = await transcribeAudio(new Blob(['x']), 'audio/mp4', onPartial)
    expect(text).toBe('hello world')
    expect(onPartial).not.toHaveBeenCalled()
  })

  it('names the upload clip.webm for webm mime types', async () => {
    const fetchMock = stubFetch(sseResponse(['data: ok\n\n']))
    await transcribeAudio(new Blob(['x']), 'audio/webm;codecs=opus')
    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect((form.get('file') as File).name).toBe('clip.webm')
  })

  it('names the upload clip.audio for unknown mime types', async () => {
    const fetchMock = stubFetch(sseResponse(['data: ok\n\n']))
    await transcribeAudio(new Blob(['x']), 'audio/ogg')
    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect((form.get('file') as File).name).toBe('clip.audio')
  })

  it('throws on a non-ok response', async () => {
    stubFetch(new Response('busy', { status: 503 }))
    await expect(transcribeAudio(new Blob(['x']), 'audio/mp4')).rejects.toThrow(
      'transcription failed: HTTP 503',
    )
  })
})
