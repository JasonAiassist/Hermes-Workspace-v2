/**
 * Behavior tests for sse-stream-parser.
 *
 * Verifies:
 *   - Buffers partial chunks across read boundaries
 *   - Flushes a complete event when a blank line arrives
 *   - Joins multi-line `data:` fields with '\n'
 *   - Calls onEnd exactly once after the stream ends
 *   - Calls onError (not onEnd) when reader.read rejects
 *   - Tolerates empty data lines (no spurious events)
 */

import { describe, it, expect, vi } from 'vitest'
import { consumeSseStream } from '../sse-stream-parser'

class FakeReader {
  private chunks: Uint8Array[]
  private idx = 0
  constructor(chunks: string[]) {
    this.chunks = chunks.map((c) => new TextEncoder().encode(c))
  }
  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.idx >= this.chunks.length) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return Promise.resolve({
      done: false,
      value: this.chunks[this.idx++],
    })
  }
  releaseLock(): void {
    /* noop */
  }
}

describe('consumeSseStream', () => {
  it('parses a single complete event', async () => {
    const events: Array<{ event: string; data: string }> = []
    const onEnd = vi.fn()
    const reader = new FakeReader([
      'event: hello\ndata: {"x":1}\n\n',
    ]) as unknown as ReadableStreamDefaultReader<Uint8Array>

    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd,
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([{ event: 'hello', data: '{"x":1}' }])
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('buffers a partial chunk and combines with the next read', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader([
      'event: mess',
      'age\ndata: {"v":1}\n\n',
    ]) as unknown as ReadableStreamDefaultReader<Uint8Array>

    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([{ event: 'message', data: '{"v":1}' }])
  })

  it('joins multi-line data fields with newlines', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader([
      'event: chunk\ndata: line1\ndata: line2\n\n',
    ]) as unknown as ReadableStreamDefaultReader<Uint8Array>

    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([{ event: 'chunk', data: 'line1\nline2' }])
  })

  it('parses multiple events in sequence', async () => {
    const events: Array<{ event: string; data: string }> = []
    const onEnd = vi.fn()
    const reader = new FakeReader([
      'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n',
    ]) as unknown as ReadableStreamDefaultReader<Uint8Array>

    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd,
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('does not emit an event when event: is missing (data: alone)', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader(['data: {"v":1}\n\n']) as unknown as ReadableStreamDefaultReader<Uint8Array>
    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([])
  })

  it('does not emit an event when data: is missing', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader(['event: alone\n\n']) as unknown as ReadableStreamDefaultReader<Uint8Array>
    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([])
  })

  it('reports errors via onError when reader.read rejects', async () => {
    const onError = vi.fn()
    const onEnd = vi.fn()
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('connection lost')),
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    consumeSseStream(reader, {
      onEvent: () => {},
      onError,
      onEnd,
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('connection lost')
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('flushes a trailing event that lacks a trailing blank line', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader(['event: eod\ndata: done']) as unknown as ReadableStreamDefaultReader<Uint8Array>
    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(events).toEqual([{ event: 'eod', data: 'done' }])
  })

  it('trims whitespace from event names', async () => {
    const events: Array<{ event: string; data: string }> = []
    const reader = new FakeReader(['event:   spaced   \ndata: x\n\n']) as unknown as ReadableStreamDefaultReader<Uint8Array>
    consumeSseStream(reader, {
      onEvent: (event, data) => events.push({ event, data }),
      onError: () => {},
      onEnd: () => {},
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(events[0].event).toBe('spaced')
  })
})