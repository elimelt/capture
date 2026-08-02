import { describe, expect, it } from 'vitest'
import { classifyFailure, describeFailure, EnrichmentError, isRetryableStatus } from './error'

describe('isRetryableStatus', () => {
  it('treats 408, 429 and every 5xx as retryable', () => {
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(599)).toBe(true)
  })

  it('treats every other 4xx as permanent', () => {
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableStatus(413)).toBe(false)
    expect(isRetryableStatus(415)).toBe(false)
  })
})

describe('classifyFailure', () => {
  it('reads retryable/hostDown straight off an EnrichmentError', () => {
    expect(classifyFailure(new EnrichmentError('x', { retryable: false }))).toEqual({
      retryable: false,
      hostDown: false,
    })
    expect(classifyFailure(new EnrichmentError('x', { retryable: true }))).toEqual({
      retryable: true,
      hostDown: false,
    })
    expect(classifyFailure(new EnrichmentError('x', { retryable: true, hostDown: true }))).toEqual({
      retryable: true,
      hostDown: true,
    })
  })

  it('treats a fetch network failure (TypeError) as retryable and host-down', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toEqual({
      retryable: true,
      hostDown: true,
    })
  })

  it('treats an AbortSignal.timeout() failure as retryable and host-down', () => {
    expect(classifyFailure(new DOMException('signal timed out', 'TimeoutError'))).toEqual({
      retryable: true,
      hostDown: true,
    })
    expect(classifyFailure(new DOMException('aborted', 'AbortError'))).toEqual({
      retryable: true,
      hostDown: true,
    })
  })

  it('defaults an unrecognized error to retryable, not host-down', () => {
    expect(classifyFailure(new Error('boom'))).toEqual({ retryable: true, hostDown: false })
    expect(classifyFailure('boom')).toEqual({ retryable: true, hostDown: false })
    expect(classifyFailure(undefined)).toEqual({ retryable: true, hostDown: false })
  })
})

describe('describeFailure', () => {
  it("returns an Error's message", () => {
    expect(describeFailure(new Error('transcription failed: HTTP 413'))).toBe(
      'transcription failed: HTTP 413',
    )
  })

  it('stringifies a non-Error throw', () => {
    expect(describeFailure('boom')).toBe('boom')
  })
})
