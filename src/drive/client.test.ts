import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DriveError,
  FOLDER_MIME,
  createFolder,
  findFile,
  listChildren,
  readFileBlob,
  readFileText,
  updateFileContent,
  uploadFile,
} from './client'

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const res of responses) fetchMock.mockResolvedValueOnce(res)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('findFile', () => {
  it('builds an escaped query and returns the first id', async () => {
    const fetchMock = stubFetch(jsonResponse({ files: [{ id: 'file-1' }] }))
    const id = await findFile('tok', { name: "a'b", parentId: 'root', mimeType: FOLDER_MIME })
    expect(id).toBe('file-1')

    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))
    const q = parsed.searchParams.get('q') ?? ''
    expect(q).toContain("name = 'a\\'b'")
    expect(q).toContain("'root' in parents")
    expect(q).toContain('trashed = false')
    expect(q).toContain(`mimeType = '${FOLDER_MIME}'`)
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('returns null when no file matches', async () => {
    stubFetch(jsonResponse({ files: [] }))
    expect(await findFile('tok', { name: 'x', parentId: 'root' })).toBeNull()
  })
})

describe('createFolder', () => {
  it('posts folder metadata and returns the new id', async () => {
    const fetchMock = stubFetch(jsonResponse({ id: 'folder-1' }))
    const id = await createFolder('tok', 'timebox', 'root')
    expect(id).toBe('folder-1')

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'timebox',
      parents: ['root'],
      mimeType: FOLDER_MIME,
    })
  })
})

describe('uploadFile', () => {
  it('uses multipart for small bodies and returns the id', async () => {
    const fetchMock = stubFetch(jsonResponse({ id: 'up-1' }))
    const id = await uploadFile('tok', {
      name: 'rec.json',
      parentId: 'p',
      mimeType: 'application/json',
      body: '{"a":1}',
    })
    expect(id).toBe('up-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('uploadType=multipart')
    expect(init?.method).toBe('POST')
    const body = init?.body as Blob
    expect(body.type).toMatch(/^multipart\/related; boundary=/)
  })

  it('uses resumable for bodies over 5MB', async () => {
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'audio/mp4' })
    const initRes = new Response(null, {
      status: 200,
      headers: { location: 'https://upload.example/session' },
    })
    const fetchMock = stubFetch(initRes, jsonResponse({ id: 'up-2' }))
    const id = await uploadFile('tok', {
      name: 'clip.m4a',
      parentId: 'p',
      mimeType: 'audio/mp4',
      body: big,
    })
    expect(id).toBe('up-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('uploadType=resumable')
    const [sessionUrl, putInit] = fetchMock.mock.calls[1]
    expect(String(sessionUrl)).toBe('https://upload.example/session')
    expect(putInit?.method).toBe('PUT')
  })
})

describe('DriveError classification', () => {
  it('marks 401/403 as auth and 429/5xx as retryable', async () => {
    stubFetch(jsonResponse({ error: { message: 'no' } }, 401))
    await expect(findFile('tok', { name: 'x', parentId: 'root' })).rejects.toMatchObject({
      status: 401,
    })

    const e429 = new DriveError(429, 'slow down')
    expect(e429.isRetryable).toBe(true)
    expect(e429.isAuth).toBe(false)
    const e403 = new DriveError(403, 'scope')
    expect(e403.isAuth).toBe(true)
    const e500 = new DriveError(500, 'boom')
    expect(e500.isRetryable).toBe(true)
  })
})

describe('readFileText', () => {
  it('reads media contents as text', async () => {
    const fetchMock = stubFetch(new Response('checkpoint-body', { status: 200 }))
    const text = await readFileText('tok', 'file-9')
    expect(text).toBe('checkpoint-body')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/file-9?alt=media')
  })
})

describe('readFileBlob', () => {
  it('reads media contents as a Blob', async () => {
    const fetchMock = stubFetch(new Response(new Blob(['audio-bytes']), { status: 200 }))
    const blob = await readFileBlob('tok', 'file-3')
    expect(await blob.text()).toBe('audio-bytes')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/file-3?alt=media')
  })
})

describe('listChildren', () => {
  it('queries non-trashed children of the parent', async () => {
    const files = [{ id: 'f1', name: 'a.json', mimeType: 'application/json' }]
    const fetchMock = stubFetch(jsonResponse({ files }))
    expect(await listChildren('tok', 'parent-1')).toEqual(files)

    const q = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('q') ?? ''
    expect(q).toContain("'parent-1' in parents")
    expect(q).toContain('trashed = false')
  })

  it('follows nextPageToken across pages', async () => {
    const page1 = [{ id: 'f1', name: 'a.json', mimeType: 'application/json' }]
    const page2 = [{ id: 'f2', name: 'b.json', mimeType: 'application/json' }]
    const fetchMock = stubFetch(
      jsonResponse({ files: page1, nextPageToken: 'tok-2' }),
      jsonResponse({ files: page2 }),
    )
    expect(await listChildren('tok', 'parent-1')).toEqual([...page1, ...page2])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const second = new URL(String(fetchMock.mock.calls[1][0]))
    expect(second.searchParams.get('pageToken')).toBe('tok-2')
  })
})

describe('updateFileContent', () => {
  it('PATCHes the media body in place for an existing file id', async () => {
    const fetchMock = stubFetch(jsonResponse({ id: 'cfg-1' }))
    await updateFileContent('tok', 'cfg-1', 'application/json', '{"a":2}')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/files/cfg-1?uploadType=media')
    expect(init?.method).toBe('PATCH')
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })
})
