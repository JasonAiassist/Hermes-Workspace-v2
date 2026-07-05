/**
 * Behavior tests for hermes-stream.
 *
 * Verifies:
 *   - streamChat parses SSE events line-by-line with current-event
 *     tracking across event:/data: pairs
 *   - streamChat handles partial chunks by buffering the trailing
 *     partial line until the next read
 *   - streamChat skips [DONE] sentinels
 *   - streamChat swallows malformed JSON without crashing
 *   - streamChat throws on non-OK responses and missing body
 *   - streamChat respects AbortSignal
 *   - sendChat accepts both string and object message args
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../hermes-api-client', () => ({
  authHeaders: vi.fn().mockReturnValue({ Authorization: 'Bearer t' }),
  hermesPost: vi.fn(),
  resolveBaseUrl: vi.fn().mockResolvedValue('http://gw:9999'),
}))

import { authHeaders, hermesPost, resolveBaseUrl } from '../hermes-api-client'
import { sendChat, streamChat } from '../hermes-stream'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authHeaders).mockReturnValue({ Authorization: 'Bearer t' })
  vi.mocked(resolveBaseUrl).mockResolvedValue('http://gw:9999')
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Fake SSE stream ───────────────────────────────────────────────────

class FakeSSEStream {
  private chunks: Uint8Array[]
  private idx = 0
  constructor(chunks: string[]) {
    this.chunks = chunks.map((c) => new TextEncoder().encode(c))
  }
  getReader(): ReadableStreamDefaultReader<Uint8Array> {
    const chunks = this.chunks
    let idx = 0
    return {
      read: async () => {
        if (idx >= chunks.length) return { done: true, value: undefined }
        const value = chunks[idx++]
        return { done: false, value }
      },
      releaseLock: () => {},
      closed: Promise.resolve(),
      cancel: async () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
  }
}

// ── streamChat ────────────────────────────────────────────────────────

describe('streamChat', () => {
  it('parses event:/data: pairs and dispatches via onEvent', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const sse = new FakeSSEStream([
      'event: message\ndata: {"id":1}\n\nevent: done\ndata: {"ok":true}\n\n',
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: sse,
      }),
    )

    await streamChat(
      's1',
      { message: 'hi' },
      { onEvent: (e) => events.push(e) },
      'sage',
    )

    expect(events).toEqual([
      { event: 'message', data: { id: 1 } },
      { event: 'done', data: { ok: true } },
    ])
    expect(resolveBaseUrl).toHaveBeenCalledWith('sage')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://gw:9999/api/sessions/s1/chat/stream',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'hi' }),
      }),
    )
  })

  it('buffers partial chunks until a complete line arrives', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    // First chunk ends mid-line; second chunk completes it.
    const sse = new FakeSSEStream([
      'event: mess',
      'age\ndata: {"id":1}\n\n',
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse }),
    )

    await streamChat('s1', { message: 'x' }, { onEvent: (e) => events.push(e) })

    expect(events).toEqual([{ event: 'message', data: { id: 1 } }])
  })

  it('skips [DONE] sentinel data lines', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const sse = new FakeSSEStream(['event: end\ndata: [DONE]\n\n'])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse }),
    )

    await streamChat('s1', { message: 'x' }, { onEvent: (e) => events.push(e) })
    expect(events).toEqual([])
  })

  it('swallows malformed JSON without crashing', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const sse = new FakeSSEStream(['event: x\ndata: {not json\n\ndata: {"good":1}\n\n'])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse }),
    )

    await streamChat('s1', { message: 'x' }, { onEvent: (e) => events.push(e) })
    expect(events).toEqual([{ event: 'x', data: { good: 1 } }])
  })

  it('defaults event name to "message" when only data: line is present', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const sse = new FakeSSEStream(['data: {"v":1}\n\n'])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse }),
    )

    await streamChat('s1', { message: 'x' }, { onEvent: (e) => events.push(e) })
    expect(events[0].event).toBe('message')
  })

  it('throws on non-OK response with status in message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('upstream down'),
      }),
    )
    await expect(
      streamChat('s1', { message: 'x' }, { onEvent: () => {} }),
    ).rejects.toThrow(/502 upstream down/)
  })

  it('throws when response body is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }),
    )
    await expect(
      streamChat('s1', { message: 'x' }, { onEvent: () => {} }),
    ).rejects.toThrow('No response body')
  })

  it('forwards AbortSignal to fetch', async () => {
    const sse = new FakeSSEStream(['data: {"v":1}\n\n'])
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse })
    vi.stubGlobal('fetch', fetchSpy)

    const controller = new AbortController()
    await streamChat(
      's1',
      { message: 'x' },
      { onEvent: () => {}, signal: controller.signal },
      'sage',
    )
    expect(fetchSpy.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('passes model, system_message, attachments through to FastAPI', async () => {
    const sse = new FakeSSEStream(['data: {"ok":true}\n\n'])
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, body: sse })
    vi.stubGlobal('fetch', fetchSpy)

    await streamChat(
      's1',
      {
        message: 'hi',
        model: 'kimi',
        system_message: 'be terse',
        attachments: [{ kind: 'file', name: 'x.txt' }],
      },
      { onEvent: () => {} },
    )

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({
      message: 'hi',
      model: 'kimi',
      system_message: 'be terse',
      attachments: [{ kind: 'file', name: 'x.txt' }],
    })
  })
})

// ── sendChat ──────────────────────────────────────────────────────────

describe('sendChat', () => {
  it('accepts a string message + model arg (legacy shape)', async () => {
    vi.mocked(hermesPost).mockResolvedValue({ id: 'r1' })
    const out = await sendChat('s1', 'hi', 'kimi', 'sage')
    expect(out).toEqual({ id: 'r1' })
    expect(hermesPost).toHaveBeenCalledWith(
      '/api/sessions/s1/chat',
      { message: 'hi', model: 'kimi' },
      'sage',
    )
  })

  it('accepts an object message + model (modern shape)', async () => {
    vi.mocked(hermesPost).mockResolvedValue({ id: 'r2' })
    const out = await sendChat(
      's1',
      { message: 'hi', model: 'kimi' },
      undefined,
      'sage',
    )
    expect(out).toEqual({ id: 'r2' })
    expect(hermesPost).toHaveBeenCalledWith(
      '/api/sessions/s1/chat',
      { message: 'hi', model: 'kimi' },
      'sage',
    )
  })
})