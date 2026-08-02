import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendCapture } from '../store/events'
import { useFreshIndexedDb } from '../testing/freshDb'
import { driveClientMock, fakeDrive, setActiveFakeDrive, type FakeDrive } from './testing/fakeDrive'

useFreshIndexedDb()

vi.mock('./client', () => driveClientMock())

let drive: FakeDrive

beforeEach(() => {
  drive = fakeDrive()
  setActiveFakeDrive(drive)
})

describe('syncContextFile', () => {
  it('creates and then updates the stable root context file', async () => {
    const { ensureTree } = await import('./bootstrap')
    const { syncContextFile, CONTEXT_FILE_NAME } = await import('./context')
    await ensureTree('tok', ['timelog'])
    await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T09:04:11-04:00',
      attachments: [
        { kind: 'text', blob: new Blob(['Plan the afternoon']), mimeType: 'text/plain' },
      ],
    })

    await syncContextFile('tok')
    const context = drive.nodes.find((node) => node.name === CONTEXT_FILE_NAME)
    expect(context).toBeDefined()
    expect(await new Blob([context!.content as string]).text()).toContain('Plan the afternoon')
    expect(context?.appProperties).toEqual({ captureKind: 'context' })

    await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T10:00:00-04:00',
      attachments: [],
    })
    await syncContextFile('tok')

    expect(drive.nodes.filter((node) => node.name === CONTEXT_FILE_NAME)).toHaveLength(1)
    expect(await new Blob([context!.content as string]).text()).toContain('2026-08-02 10:00:00')
    expect(drive.updateFileContent).toHaveBeenCalledTimes(1)
  })
})
