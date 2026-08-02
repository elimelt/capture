import { describe, expect, it } from 'vitest'
import { scaledDimensions } from './photo'

describe('scaledDimensions', () => {
  it('leaves a source already under the cap untouched', () => {
    expect(scaledDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })

  it('never upscales a source exactly at the cap', () => {
    expect(scaledDimensions(2048, 1024, 2048)).toEqual({ width: 2048, height: 1024 })
  })

  it('downscales a landscape source, preserving aspect ratio', () => {
    expect(scaledDimensions(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
  })

  it('downscales a portrait source by its long (vertical) edge', () => {
    expect(scaledDimensions(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('downscales a square source', () => {
    expect(scaledDimensions(4000, 4000, 2048)).toEqual({ width: 2048, height: 2048 })
  })

  it('never yields a zero dimension for extreme aspect ratios', () => {
    expect(scaledDimensions(10000, 1, 2048)).toEqual({ width: 2048, height: 1 })
    expect(scaledDimensions(1, 10000, 2048)).toEqual({ width: 1, height: 2048 })
  })
})
