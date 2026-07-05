/**
 * Behavior tests for /api/agent-kill.
 *
 * Kill terminates an active agent session by deleting the underlying
 * gateway session. Verifies:
 *   - 401 when unauthenticated
 *   - 400 when sessionKey missing
 *   - Resolves with killed:true and the (stripped) sessionKey
 *   - Strips profile prefix before forwarding to deleteSession
 *   - Resolves profile from qualified key OR X-Hermes-Profile header
 *   - Calls ensureGatewayProbed before deleteSession
 *   - 500 on deleteSession failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
const ensureGatewayProbedMock = vi.hoisted(() => vi.fn(async () => undefined))
const deleteSessionMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: isAuthenticatedMock,
}))
vi.mock('../../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))
vi.mock('../../../server/hermes-api', () => ({
  ensureGatewayProbed: ensureGatewayProbedMock,
  deleteSession: deleteSessionMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isAuthenticatedMock.mockReturnValue(true)
  ensureGatewayProbedMock.mockResolvedValue(undefined)
  deleteSessionMock.mockResolvedValue(undefined)
})

async function getHandler() {
  vi.resetModules()
  const mod = await import('../agent-kill')
  return (mod as any).Route.server.handlers.POST
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/agent-kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('/api/agent-kill', () => {
  it('rejects unauthenticated with 401', async () => {
    isAuthenticatedMock.mockReturnValue(false)
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'k' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when sessionKey missing', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest({}) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/sessionKey is required/)
  })

  it('strips profile prefix and forwards bare key to deleteSession', async () => {
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc-123' }),
    })
    expect(res.status).toBe(200)
    expect(deleteSessionMock).toHaveBeenCalledWith('abc-123', 'sage')
    const body = await res.json()
    expect(body).toEqual({ ok: true, sessionKey: 'abc-123', killed: true })
  })

  it('passes bare sessionKey without profile resolution', async () => {
    const post = await getHandler()
    await post({ request: makeRequest({ sessionKey: 'bare-key' }) })
    expect(deleteSessionMock).toHaveBeenCalledWith('bare-key', undefined)
  })

  it('uses X-Hermes-Profile header when key has no prefix', async () => {
    const post = await getHandler()
    await post({
      request: makeRequest(
        { sessionKey: 'abc' },
        { 'X-Hermes-Profile': 'jarvis' },
      ),
    })
    expect(deleteSessionMock).toHaveBeenCalledWith('abc', 'jarvis')
  })

  it('prefers X-Hermes-Profile over qualified-key profile', async () => {
    const post = await getHandler()
    await post({
      request: makeRequest(
        { sessionKey: 'profile:sage:abc' },
        { 'X-Hermes-Profile': 'jarvis' },
      ),
    })
    expect(deleteSessionMock).toHaveBeenCalledWith('abc', 'jarvis')
  })

  it('calls ensureGatewayProbed before deleteSession', async () => {
    const callOrder: string[] = []
    ensureGatewayProbedMock.mockImplementation(async () => {
      callOrder.push('probe')
    })
    deleteSessionMock.mockImplementation(async () => {
      callOrder.push('delete')
    })
    const post = await getHandler()
    await post({ request: makeRequest({ sessionKey: 'profile:sage:abc' }) })
    expect(callOrder).toEqual(['probe', 'delete'])
  })

  it('returns 500 when deleteSession rejects', async () => {
    deleteSessionMock.mockRejectedValue(new Error('gateway down'))
    const post = await getHandler()
    const res = await post({
      request: makeRequest({ sessionKey: 'profile:sage:abc' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('gateway down')
  })

  it('returns 500 on malformed JSON', async () => {
    const post = await getHandler()
    const res = await post({ request: makeRequest('{bad') })
    expect(res.status).toBe(500)
  })

  it('returns 500 with default message when error is not an Error instance', async () => {
    const post = await getHandler()
    const weirdReq = new Proxy(makeRequest({ sessionKey: 'profile:sage:abc' }), {
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
    expect(body.error).toBe('Failed to kill agent')
  })
})