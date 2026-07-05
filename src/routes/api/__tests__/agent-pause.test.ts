/**
 * Behavior tests for /api/agent-pause.
 *
 * Pause/resume is intentionally client-side only; the endpoint
 * exists for UI uniformity. Verifies:
 *   - 401 on unauthenticated
 *   - 400 on missing sessionKey
 *   - Resolves with clientSideOnly:true and the original key
 *   - Profile hint extracted from qualified sessionKey
 *   - Profile hint from X-Hermes-Profile header when key is bare
 *   - 500 on parse error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

vi.mock('../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isAuthenticatedMock.mockReturnValue(true)
})

async function getHandler() {
  vi.resetModules()
  const mod = await import('../agent-pause')
  return (mod as any).Route.server.handlers.POST
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/agent-pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('/api/agent-pause', () => {
  it('rejects unauthenticated requests with 401', async () => {
    isAuthenticatedMock.mockReturnValue(false)
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'k', pause: true }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('returns 400 when sessionKey is missing', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ pause: true }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/sessionKey is required/)
  })

  it('returns 400 when sessionKey is whitespace', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: '   ', pause: true }),
    })
    expect(res.status).toBe(400)
  })

  it('acks with clientSideOnly:true and original key', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc', pause: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.sessionKey).toBe('profile:sage:abc')
    expect(body.profile).toBe('sage')
    expect(body.clientSideOnly).toBe(true)
  })

  it('uses X-Hermes-Profile header when sessionKey is bare', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest(
        { sessionKey: 'abc', pause: false },
        { 'X-Hermes-Profile': 'jarvis' },
      ),
    })
    const body = await res.json()
    expect(body.profile).toBe('jarvis')
  })

  it('falls back to undefined profile when key is bare and no header', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'abc', pause: true }),
    })
    const body = await res.json()
    expect(body.profile).toBeUndefined()
  })

  it('coerces pause=false to a boolean (not omitted)', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'abc' }),
    })
    expect(res.status).toBe(200)
  })

  it('returns 500 on malformed JSON', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest('{not json'),
    })
    expect(res.status).toBe(500)
  })

  it('returns 500 with default message when error is not an Error instance', async () => {
    const post = await getHandler()
    const weirdReq = new Proxy(makeRequest({ sessionKey: 'k' }), {
      get(target, prop) {
        if (prop === 'json') return () => Promise.reject('raw string')
        if (prop === 'headers') return target.headers
        if (prop === 'url') return target.url
        return (target as any)[prop]
      },
    })
    const res = await post({ request: weirdReq })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to pause agent')
  })
})