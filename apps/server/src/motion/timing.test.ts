import { describe, expect, it } from 'vite-plus/test'
import { MotionParams } from '@plein/nodes'
import { assertMotionSourceDuration, motionMediaWindow } from './timing'

describe('motion video source window', () => {
  it('accepts a short source when its visible slot is shorter than the composition', () => {
    const params = MotionParams.parse({
      template: 'video-title',
      duration: 6,
      sourceIn: 0.1,
      speed: 1,
      overrides: { 'hf-media.timing.start': 2, 'hf-media.timing.end': 2.5 },
    })
    expect(motionMediaWindow(params)).toMatchObject({
      start: 2,
      end: 2.5,
      duration: 0.5,
      sourceEnd: 0.6,
    })
    expect(() => assertMotionSourceDuration(params, 0.75)).not.toThrow()
  })
  it('rejects a media slot that needs more source than is available', () => {
    const params = MotionParams.parse({
      template: 'video-title',
      duration: 6,
      sourceIn: 0.1,
      speed: 2,
      overrides: { 'hf-media.timing.start': 2, 'hf-media.timing.end': 2.5 },
    })
    expect(() => assertMotionSourceDuration(params, 0.75)).toThrow('visible media slot')
  })
  it('quantizes both media edges to frames before calculating required source time', () => {
    const params = MotionParams.parse({
      template: 'video-title',
      duration: 6,
      sourceIn: 0.25,
      speed: 2,
      overrides: { 'hf-media.timing.start': 1.01, 'hf-media.timing.end': 1.49 },
    })
    expect(motionMediaWindow(params)).toEqual({
      start: 1,
      end: 1.5,
      duration: 0.5,
      sourceEnd: 1.25,
    })
    expect(() => assertMotionSourceDuration(params, 1.25)).not.toThrow()
  })
  it('uses the full quantized composition only when no media override is present', () => {
    const params = MotionParams.parse({ duration: 2.01, sourceIn: 0.5, speed: 2 })
    expect(motionMediaWindow(params).sourceEnd).toBe(4.5)
    expect(() => assertMotionSourceDuration(params, 1)).toThrow('visible media slot')
  })
})
