import { describe, expect, it } from 'vitest'
import { assembleCaption, feedLines, parseChatLine } from './stream'

const chunk = (content: string, done = false) =>
  JSON.stringify({ model: 'gemma4:e4b', message: { role: 'assistant', content }, done })

describe('feedLines', () => {
  it('returns complete lines and buffers the partial tail', () => {
    const first = feedLines('', '{"a":1}\n{"b"')
    expect(first.lines).toEqual(['{"a":1}'])
    expect(first.buffer).toBe('{"b"')

    const second = feedLines(first.buffer, ':2}\n')
    expect(second.lines).toEqual(['{"b":2}'])
    expect(second.buffer).toBe('')
  })

  it('handles several lines per chunk and skips blank lines', () => {
    const { lines, buffer } = feedLines('', '{"a":1}\n\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(buffer).toBe('')
  })

  it('strips CR from CRLF line endings', () => {
    expect(feedLines('', '{"a":1}\r\n').lines).toEqual(['{"a":1}'])
  })

  it('returns nothing for an empty chunk', () => {
    expect(feedLines('', '')).toEqual({ buffer: '', lines: [] })
  })
})

describe('parseChatLine', () => {
  it('extracts the content delta of a streaming chunk', () => {
    expect(parseChatLine(chunk(' vibrant'))).toEqual({ delta: ' vibrant', done: false })
  })

  it('flags the terminal line and tolerates its empty content', () => {
    expect(parseChatLine(chunk('', true))).toEqual({ delta: '', done: true })
    // Stats-only done line without a message object.
    expect(parseChatLine('{"done":true,"total_duration":1}')).toEqual({ delta: '', done: true })
  })

  it('throws on a server-reported error line', () => {
    expect(() => parseChatLine('{"error":"model not found"}')).toThrow(
      'caption failed: model not found',
    )
  })

  it('throws on unparsable JSON', () => {
    expect(() => parseChatLine('not json')).toThrow('caption failed: malformed stream chunk')
  })

  it('throws on a non-terminal chunk without string content', () => {
    expect(() => parseChatLine('{"message":{"content":42},"done":false}')).toThrow(
      'caption failed: no content in response',
    )
  })
})

describe('assembleCaption', () => {
  it('concatenates deltas and trims, matching the non-streaming content', () => {
    const deltas = ['A', ' latte', ' on', ' a', ' wooden', ' table.']
    expect(assembleCaption(deltas)).toBe('A latte on a wooden table.')
  })

  it('is empty when the model produced nothing', () => {
    expect(assembleCaption([])).toBe('')
    expect(assembleCaption([' '])).toBe('')
  })

  it('agrees between partial prefixes and the final result', () => {
    const deltas = ['A cat', ' on a mat.']
    expect(assembleCaption(deltas.slice(0, 1))).toBe('A cat')
    expect(assembleCaption(deltas)).toBe('A cat on a mat.')
  })
})
