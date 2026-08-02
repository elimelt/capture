import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from './api'

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcribeAudio', () => {
  it('posts a multipart form to the transcription endpoint and returns trimmed text', async () => {
    const fetchMock = stubFetch(jsonResponse({ text: '  hello world \n' }))
    const text = await transcribeAudio(new Blob(['audio-bytes']), 'audio/mp4')
    expect(text).toBe('hello world')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/v1\/audio\/transcriptions$/)
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('Systran/faster-whisper-base.en')
    expect(form.get('response_format')).toBe('json')
    expect(form.get('vad_filter')).toBe('true')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('clip.m4a')
    expect(file.type).toBe('audio/mp4')
  })

  it('names the upload clip.webm for webm mime types', async () => {
    const fetchMock = stubFetch(jsonResponse({ text: 'ok' }))
    await transcribeAudio(new Blob(['x']), 'audio/webm;codecs=opus')
    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect((form.get('file') as File).name).toBe('clip.webm')
  })

  it('names the upload clip.audio for unknown mime types', async () => {
    const fetchMock = stubFetch(jsonResponse({ text: 'ok' }))
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

  it('throws when the response JSON has no string text', async () => {
    stubFetch(jsonResponse({ text: 42 }))
    await expect(transcribeAudio(new Blob(['x']), 'audio/mp4')).rejects.toThrow(
      'no text in response',
    )
  })
})
