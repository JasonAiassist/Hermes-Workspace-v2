/**
 * Behavior tests for /api/agent-steer.
 *
 * Steer sends a directive message to an active agent session,
 * fire-and-forget through /api/send?stream=true. Verifies:
 *   - 401 when unauthenticated
 *   - 400 when sessionKey missing
 *   - 400 when message missing
 *   - Forwards to /api/send?stream=true with correct payload + headers
 *   - Includes cookie + X-Hermes-Profile header from the inbound request
 *   - Swallows /api/send errors (fire-and-forget semantics)
 *   - 500 on parse error
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

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: isAuthenticatedMock,
}))
vi.mock('../../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isAuthenticatedMock.mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function getHandler() {
  vi.resetModules()
  // Re-stub globals because vi.resetModules() also clears global
  // stubs registered via vi.stubGlobal in some Vitest versions.
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../agent-steer')
  return (mod as any).Route.server.handlers.POST
}

function makeRequest(
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return new Request('http://localhost/api/agent-steer', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'session=abc',
      ...extraHeaders,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('/api/agent-steer', () => {
  it('rejects unauthenticated with 401', async () => {
    isAuthenticatedMock.mockReturnValue(false)
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 's1', message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when sessionKey missing', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest({ message: 'hi' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/sessionKey is required/)
  })

  it('returns 400 when message missing', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest({ sessionKey: 's1' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/message is required/)
  })

  it('forwards to /api/send?stream=true with correct payload + headers', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    const post = await getHandler()
    await post({
      request: makeRequest(
        { sessionKey: 'profile:sage:abc', message: 'do the thing' },
        { 'X-Hermes-Profile': 'sage' },
      ),
    })

    // Wait for fire-and-forget fetch to flush.
    await new Promise((r) => setTimeout(r, 20))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [urlArg, init] = fetchMock.mock.calls[0]
    expect(urlArg.toString()).toBe('http://localhost/api/send?stream=true')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.cookie).toBe('session=abc')
    expect(init.headers['X-Hermes-Profile']).toBe('sage')
    expect(JSON.parse(init.body)).toEqual({
      sessionKey: 'profile:sage:abc',
      message: 'do the thing',
    })
  })

  it('omits X-Hermes-Profile when no profile in key or header', async () => {
    fetchMock.mockResolvedValue(new Response('ok'))
    const post = await getHandler()
    await post({
      request: makeRequest({ sessionKey: 'bare-key', message: 'hi' }),
    })
    await new Promise((r) => setTimeout(r, 20))
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers['X-Hermes-Profile']).toBeUndefined()
  })

  it('returns queued:true immediately even before /api/send resolves', async () => {
    let resolveFetch: ((v: Response) => void) | undefined
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        resolveFetch = r
      }),
    )
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 's1', message: 'hi' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, sessionKey: 's1', queued: true })
    resolveFetch!(new Response('ok'))
  })

  it('swallows errors from /api/send (UI discovers via SSE/poll)', async () => {
    fetchMock.mockRejectedValue(new Error('downstream down'))
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 's1', message: 'hi' }),
    })
    expect(res.status).toBe(200)
  })

  it('returns 500 on malformed JSON', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest('{bad') })
    expect(res.status).toBe(500)
  })

  it('returns 500 with default message when error is not an Error instance', async () => {
    const post = await getHandler()
    // Proxy a request whose .json() rejects with a non-Error throwable
    // so the catch branch hits the "Failed to steer agent" fallback.
    const weirdReq = new Proxy(makeRequest({}), {
      get(target, prop) {
        if (prop === 'json') return () => Promise.reject('plain string throw')
        if (prop === 'headers') return target.headers
        if (prop === 'url') return target.url
        return (target as any)[prop]
      },
    })
    const res = await post({ request: weirdReq })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to steer agent')
  })
})