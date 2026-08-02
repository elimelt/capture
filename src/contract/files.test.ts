import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_SCHEMA,
  STREAMS_SCHEMA,
  STREAM_CONFIG_SCHEMA,
  checkpointStub,
  serializeCheckpoint,
  serializeStreamConfig,
  serializeStreamsRegistry,
  streamConfigStub,
} from './files'

describe('serializeStreamsRegistry', () => {
  it('writes schema + streams with a trailing newline', () => {
    expect(serializeStreamsRegistry({ streams: ['timelog'] })).toBe(
      `{\n  "schema": "${STREAMS_SCHEMA}",\n  "streams": [\n    "timelog"\n  ]\n}\n`,
    )
  })
})

describe('serializeStreamConfig', () => {
  it('serializes the bootstrap stub with an empty body', () => {
    const parsed = JSON.parse(serializeStreamConfig(streamConfigStub('timelog')))
    expect(parsed).toEqual({
      schema: STREAM_CONFIG_SCHEMA,
      stream: 'timelog',
      skillConfig: {},
      userNotes: '',
    })
  })

  it('keeps envelope keys ahead of the body and omits absent fields', () => {
    const s = serializeStreamConfig({ stream: 'timelog', skillConfig: { a: 1 } })
    expect(s.indexOf('"schema"')).toBeLessThan(s.indexOf('"stream"'))
    expect(s.indexOf('"stream"')).toBeLessThan(s.indexOf('"skillConfig"'))
    expect(s).not.toContain('userNotes')
    expect(s.endsWith('}\n')).toBe(true)
  })
})

describe('serializeCheckpoint', () => {
  it('serializes the stub without a consumer', () => {
    const s = serializeCheckpoint(checkpointStub('timelog', '2026-08-02T09:00:00-04:00'))
    expect(JSON.parse(s)).toEqual({
      schema: CHECKPOINT_SCHEMA,
      stream: 'timelog',
      consumedThroughSeq: 0,
      updatedAt: '2026-08-02T09:00:00-04:00',
    })
    expect(s).not.toContain('consumer')
  })

  it('includes consumer when present', () => {
    const s = serializeCheckpoint({
      stream: 'timelog',
      consumedThroughSeq: 40,
      updatedAt: '2026-08-01T21:03:00-04:00',
      consumer: 'timelog-skill@claude',
    })
    expect(s).toContain('"consumer": "timelog-skill@claude"')
  })
})
