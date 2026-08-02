import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateIds } from './client'
import { BATCH_SIZE, allocateIds, resetIdPool } from './ids'

vi.mock('./client', () => ({
  generateIds: vi.fn(),
}))

const generateIdsMock = vi.mocked(generateIds)
let minted = 0

beforeEach(() => {
  resetIdPool()
  minted = 0
  generateIdsMock.mockImplementation(async (_t, count) =>
    Array.from({ length: count }, () => `gen-${minted++}`),
  )
})

afterEach(() => {
  generateIdsMock.mockReset()
})

describe('allocateIds', () => {
  it('fetches a whole batch on first use and serves later calls from the pool', async () => {
    expect(await allocateIds('tok', 2)).toEqual(['gen-0', 'gen-1'])
    expect(generateIdsMock).toHaveBeenCalledTimes(1)
    expect(generateIdsMock).toHaveBeenCalledWith('tok', BATCH_SIZE)

    // The remaining BATCH_SIZE - 2 ids come from the pool: no more requests.
    expect(await allocateIds('tok', BATCH_SIZE - 2)).toHaveLength(BATCH_SIZE - 2)
    expect(generateIdsMock).toHaveBeenCalledTimes(1)
  })

  it('refills with a fresh batch once the pool runs dry', async () => {
    await allocateIds('tok', BATCH_SIZE)
    expect(generateIdsMock).toHaveBeenCalledTimes(1)

    expect(await allocateIds('tok', 1)).toEqual([`gen-${BATCH_SIZE}`])
    expect(generateIdsMock).toHaveBeenCalledTimes(2)
  })

  it('fetches enough in one request when asked for more than a batch', async () => {
    const ids = await allocateIds('tok', BATCH_SIZE + 5)
    expect(ids).toHaveLength(BATCH_SIZE + 5)
    expect(generateIdsMock).toHaveBeenCalledTimes(1)
    expect(generateIdsMock).toHaveBeenCalledWith('tok', BATCH_SIZE + 5)
  })

  it('never hands out the same id twice', async () => {
    const a = await allocateIds('tok', 3)
    const b = await allocateIds('tok', 3)
    expect(new Set([...a, ...b]).size).toBe(6)
  })

  it('resetIdPool forgets pooled ids (test hook)', async () => {
    await allocateIds('tok', 1)
    resetIdPool()
    await allocateIds('tok', 1)
    expect(generateIdsMock).toHaveBeenCalledTimes(2)
  })
})
