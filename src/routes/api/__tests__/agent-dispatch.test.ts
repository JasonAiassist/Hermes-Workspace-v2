/**
 * Behavior tests for /api/agent-dispatch.
 *
 * Dispatch forwards a mission task to the gateway's /api/send?stream=true
 * endpoint, parses the SSE response in the background, and republishes
 * error events to chat-event-bus. Verifies:
 *   - 401 when unauthenticated
 *   - 400 when sessionKey missing
 *   - 400 when message missing
 *   - Forwards to /api/send?stream=true with stripped key + correct headers
 *   - Returns 502 when /api/send fetch fails (network)
 *   - Returns 502 when /api/send returns non-OK
 *   - Returns 502 when response content-type is not SSE
 *   - Publishes mission events when SSE 'error' event arrives
 *   - Publishes a mission event when SSE stream ends unexpectedly
 *   - Passes through model, missionName, agentId when provided
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => opts,
}))

vi.mock('@tanstack/react-start', () => ({
  json: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...(init || {}),
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    }),
}))

const isAuthenticatedMock = vi.hoisted(() => vi.fn(() => true))
const publishMissionEventMock = vi.hoisted(() => vi.fn())

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: isAuthenticatedMock,
}))
vi.mock('../../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))
vi.mock('../../../server/chat-event-bus', () => ({
  publishMissionEvent: publishMissionEventMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isAuthenticatedMock.mockReturnValue(true)
  publishMissionEventMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function getHandler() {
  vi.resetModules()
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../agent-dispatch')
  return (mod as any).Route.server.handlers.POST
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/agent-dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'session=abc', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/**
 * Build a fake ReadableStream from an array of SSE strings.
 */
function fakeSseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk))
      }
      controller.close()
    },
  })
}

describe('/api/agent-dispatch', () => {
  it('rejects unauthenticated with 401', async () => {
    isAuthenticatedMock.mockReturnValue(false)
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'k', message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when sessionKey missing', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest({ message: 'hi' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sessionKey is required/)
  })

  it('returns 400 when message missing', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest({ sessionKey: 'k' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/message is required/)
  })

  it('strips profile prefix and forwards bare sessionKey to /api/send', async () => {
    fetchMock.mockResolvedValue(
      new Response(fakeSseBody(['data: {"ok":true}\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    await post({
      request: makeRequest(
        { sessionKey: 'profile:sage:abc', message: 'do it' },
        { 'X-Hermes-Profile': 'sage' },
      ),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [urlArg, init] = fetchMock.mock.calls[0]
    expect(urlArg.toString()).toBe('http://localhost/api/send?stream=true')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      sessionKey: 'abc',
      message: 'do it',
      source: 'mission',
    })
    expect(init.headers['X-Hermes-Profile']).toBe('sage')
    expect(init.headers.cookie).toBe('session=abc')
    // Long timeout for agent runs.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('includes model, missionName, agentId in payload when provided', async () => {
    fetchMock.mockResolvedValue(
      new Response(fakeSseBody(['data: {"ok":true}\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({
        sessionKey: 'profile:sage:abc',
        message: 'do it',
        model: 'kimi',
        missionName: 'Forge',
        agentId: 'coding-forge',
      }),
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      sessionKey: 'abc',
      message: 'do it',
      model: 'kimi',
      missionName: 'Forge',
      agentId: 'coding-forge',
      source: 'mission',
    })
  })

  it('returns 502 when /api/send fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Failed to reach \/api\/send/)
  })

  it('returns 502 when /api/send returns non-OK', async () => {
    fetchMock.mockResolvedValue(
      new Response('downstream exploded', { status: 500 }),
    )
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/returned 500/)
  })

  it('returns 502 when response is not text/event-stream', async () => {
    fetchMock.mockResolvedValue(
      new Response('not a stream', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Expected SSE stream/)
  })

  it('returns queued:true immediately on successful SSE start', async () => {
    fetchMock.mockResolvedValue(
      new Response(fakeSseBody(['data: {"ok":true}\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(true)
    expect(body.sessionKey).toBe('profile:sage:abc')
  })

  it('publishes mission error events when SSE stream emits error', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        fakeSseBody([
          'event: error\ndata: {"message":"agent crashed"}\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    // Wait for SSE consumer to run.
    await new Promise((r) => setTimeout(r, 30))
    expect(publishMissionEventMock).toHaveBeenCalledWith('error', {
      message: 'agent crashed',
      sessionKey: 'profile:sage:abc',
    })
  })

  it('publishes raw data string when SSE error payload is not valid JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        fakeSseBody(['event: error\ndata: not json at all\n\n']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(publishMissionEventMock).toHaveBeenCalledWith('error', {
      message: 'not json at all',
      sessionKey: 'profile:sage:abc',
    })
  })

  it('publishes a stream-ended-unexpectedly error when no done event', async () => {
    fetchMock.mockResolvedValue(
      new Response(fakeSseBody(['data: {"partial":true}\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(publishMissionEventMock).toHaveBeenCalledWith('error', {
      message: 'Stream ended unexpectedly without completion',
      sessionKey: 'profile:sage:abc',
    })
  })

  it('does NOT publish stream-ended error when a done event arrives', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        fakeSseBody(['data: {"partial":true}\n\nevent: done\ndata: {"ok":true}\n\n']),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    await new Promise((r) => setTimeout(r, 30))
    const endCalls = publishMissionEventMock.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown>).message ===
        'Stream ended unexpectedly without completion',
    )
    expect(endCalls).toHaveLength(0)
  })

  it('returns 500 on malformed JSON request body', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest('{bad') })
    expect(res.status).toBe(500)
  })

  it('publishes a stream-read-error event when the SSE reader rejects', async () => {
    // Build an SSE body whose reader rejects mid-stream — this drives
    // the onError handler in consumeSseStream.
    const sse = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: x\n'))
        controller.error(new Error('stream exploded'))
      },
    })
    fetchMock.mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(publishMissionEventMock).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        message: expect.stringMatching(/Stream read error: stream exploded/),
        sessionKey: 'profile:sage:abc',
      }),
    )
  })

  it('handles non-Error throwables from the SSE reader', async () => {
    const sse = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: x\n'))
        controller.error('plain string from stream')
      },
    })
    fetchMock.mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(publishMissionEventMock).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        message: 'Stream read error: plain string from stream',
      }),
    )
  })

  it('returns 500 with default message when error is not an Error instance', async () => {
    const post = await getHandler()
    const weirdReq = new Proxy(
      makeRequest({ sessionKey: 'profile:sage:abc', message: 'x' }),
      {
        get(target, prop) {
          if (prop === 'json') return () => Promise.reject('raw string')
          if (prop === 'headers') return target.headers
          if (prop === 'url') return target.url
          return (target as any)[prop]
        },
      },
    )
    const res = await post({ request: weirdReq })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to dispatch message')
  })
})