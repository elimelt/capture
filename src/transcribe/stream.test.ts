import { describe, expect, it } from 'vitest'
import { assembleTranscript, feedSse } from './stream'

describe('feedSse', () => {
  it('parses a complete event and strips exactly one leading space', () => {
    const { buffer, data } = feedSse('', 'data:  run around the lake.\n\n')
    expect(buffer).toBe('')
    // "data: " + payload " run around the lake." — the segment's own leading
    // space (whisper raw segment text) must survive.
    expect(data).toEqual([' run around the lake.'])
  })

  it('parses multiple events in one chunk, in order', () => {
    const { data } = feedSse('', 'data: I spent the morning\n\ndata:  writing docs\n\n')
    expect(data).toEqual(['I spent the morning', ' writing docs'])
  })

  it('buffers a partial event until the terminator arrives', () => {
    const first = feedSse('', 'data: I spent the mor')
    expect(first.data).toEqual([])
    expect(first.buffer).toBe('data: I spent the mor')

    const second = feedSse(first.buffer, 'ning\n\ndata:  and more')
    expect(second.data).toEqual(['I spent the morning'])
    expect(second.buffer).toBe('data:  and more')
  })

  it('joins multiple data lines of one event with a newline', () => {
    const { data } = feedSse('', 'data: line one\ndata: line two\n\n')
    expect(data).toEqual(['line one\nline two'])
  })

  it('treats a bare "data" line as an empty payload', () => {
    const { data } = feedSse('', 'data\n\n')
    expect(data).toEqual([''])
  })

  it('ignores comments and non-data fields', () => {
    const { data } = feedSse('', ': keep-alive\n\nevent: ping\nid: 3\n\ndata: hi\n\n')
    expect(data).toEqual(['hi'])
  })

  it('handles CRLF line endings, including a CR split across chunks', () => {
    const first = feedSse('', 'data: one\r\n\r')
    expect(first.data).toEqual([])
    const second = feedSse(first.buffer, '\ndata: two\r\n\r\n')
    expect(second.data).toEqual(['one', 'two'])
    expect(second.buffer).toBe('')
  })

  it('returns no events for an empty chunk', () => {
    expect(feedSse('', '')).toEqual({ buffer: '', data: [] })
  })
})

describe('assembleTranscript', () => {
  it('concatenates raw segments and trims, matching the non-streaming join', () => {
    // The server's non-streaming text is "".join(segment.text).strip();
    // whisper segments carry their own leading spaces.
    const segments = [' I spent the morning writing docs', ' and then went for a run.']
    expect(assembleTranscript(segments)).toBe(
      'I spent the morning writing docs and then went for a run.',
    )
  })

  it('preserves interior whitespace exactly as sent', () => {
    expect(assembleTranscript(['a', 'b', ' c'])).toBe('ab c')
  })

  it('is empty for no segments or whitespace-only segments', () => {
    expect(assembleTranscript([])).toBe('')
    expect(assembleTranscript([' ', ''])).toBe('')
  })

  it('agrees between partial prefixes and the final result', () => {
    const segments = [' one', ' two', ' three']
    const partials = segments.map((_, i) => assembleTranscript(segments.slice(0, i + 1)))
    expect(partials).toEqual(['one', 'one two', 'one two three'])
    expect(partials[2]).toBe(assembleTranscript(segments))
  })
})
