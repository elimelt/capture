import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDriveSpace } from './space'

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

describe('fetchDriveSpace', () => {
  it('reads the account quota and sums app file bytes', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ storageQuota: { limit: '15000000000', usage: '4520000000' } }),
      jsonResponse({ files: [{ quotaBytesUsed: '1000' }, {}, { quotaBytesUsed: '250' }] }),
    )
    expect(await fetchDriveSpace('tok')).toEqual({
      usageBytes: 4_520_000_000,
      limitBytes: 15_000_000_000,
      appBytes: 1250,
    })

    const [aboutUrl, aboutInit] = fetchMock.mock.calls[0]
    expect(String(aboutUrl)).toContain('/about?fields=storageQuota')
    expect((aboutInit!.headers as Record<string, string>).Authorization).toBe('Bearer tok')

    const listUrl = new URL(String(fetchMock.mock.calls[1][0]))
    expect(listUrl.searchParams.get('q')).toBe('trashed = false')
    expect(listUrl.searchParams.get('fields')).toContain('quotaBytesUsed')
    expect((fetchMock.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    )
  })

  it('follows nextPageToken across file pages', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ storageQuota: { usage: '1', limit: '2' } }),
      jsonResponse({ files: [{ quotaBytesUsed: '100' }], nextPageToken: 'page-2' }),
      jsonResponse({ files: [{ quotaBytesUsed: '11' }] }),
    )
    expect((await fetchDriveSpace('tok')).appBytes).toBe(111)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const second = new URL(String(fetchMock.mock.calls[2][0]))
    expect(second.searchParams.get('pageToken')).toBe('page-2')
  })

  it('omits limitBytes on unlimited plans (no storageQuota.limit)', async () => {
    stubFetch(
      jsonResponse({ storageQuota: { usage: '900' } }),
      jsonResponse({ files: [] }),
    )
    const space = await fetchDriveSpace('tok')
    expect(space.usageBytes).toBe(900)
    expect(space.limitBytes).toBeUndefined()
    expect('limitBytes' in space).toBe(false)
  })

  it('classifies auth failures as DriveError for the reconnect flow', async () => {
    stubFetch(
      jsonResponse({ error: { message: 'expired' } }, 401),
      jsonResponse({ files: [] }),
    )
    await expect(fetchDriveSpace('tok')).rejects.toMatchObject({
      name: 'DriveError',
      status: 401,
      isAuth: true,
    })
  })
})
