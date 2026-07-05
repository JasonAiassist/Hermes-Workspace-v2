/**
 * Behavior tests for hermes-api-client.
 *
 * Verifies:
 *   - HTTP verb wrappers send the correct method, headers, body
 *   - Non-OK responses throw with status + body in the message
 *   - resolveBaseUrl ordering (explicit profile → context → active → CLAUDE_API)
 *   - ProfileNotFoundError fallback only fires when profileName was implicit
 *   - GatewayNotRunningError is propagated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the upstream modules that hermes-api-client depends on.
let bearerToken = 'test-bearer-xyz'
vi.mock('../gateway-capabilities', () => ({
  get BEARER_TOKEN() {
    return bearerToken
  },
  get CLAUDE_API() {
    return 'http://127.0.0.1:8642'
  },
}))

vi.mock('../gateway-pool', () => ({
  resolveGatewayHttpUrl: vi.fn(),
}))

vi.mock('../active-profile', () => ({
  getActiveProfileName: vi.fn(),
}))

vi.mock('../profile-context', () => ({
  getActiveProfileContext: vi.fn(),
  withActiveProfile: vi.fn(),
}))

vi.mock('../gateway-errors', () => ({
  ProfileNotFoundError: class ProfileNotFoundError extends Error {
    constructor(name: string) {
      super(`profile ${name} not found`)
      this.name = 'ProfileNotFoundError'
    }
  },
}))

import { BEARER_TOKEN } from '../gateway-capabilities'
import { resolveGatewayHttpUrl } from '../gateway-pool'
import { getActiveProfileName } from '../active-profile'
import {
  getActiveProfileContext,
  withActiveProfile,
} from '../profile-context'
import {
  authHeaders,
  hermesDelete,
  hermesGet,
  hermesPatch,
  hermesPost,
  resolveBaseUrl,
  withProfile,
} from '../hermes-api-client'

// ── fetch stub helper ─────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit }
type FetchResponse = {
  ok: boolean
  status: number
  bodyText?: string
  bodyJson?: unknown
}

let fetchCalls: FetchCall[] = []
let fetchResponses: FetchResponse[] = []

function installFetch(): void {
  fetchCalls = []
  fetchResponses = []
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init })
      const next = fetchResponses.shift() ?? {
        ok: true,
        status: 200,
        bodyJson: {},
      }
      return Promise.resolve({
        ok: next.ok,
        status: next.status,
        text: () => Promise.resolve(next.bodyText ?? ''),
        json: () =>
          Promise.resolve(next.bodyJson !== undefined ? next.bodyJson : {}),
      })
    }),
  )
}

beforeEach(() => {
  installFetch()
  vi.mocked(resolveGatewayHttpUrl).mockReset()
  vi.mocked(getActiveProfileContext).mockReset()
  vi.mocked(getActiveProfileName).mockReset()
  vi.mocked(withActiveProfile).mockReset()
  vi.mocked(resolveGatewayHttpUrl).mockResolvedValue('http://gw:9999')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── authHeaders ───────────────────────────────────────────────────────

describe('authHeaders', () => {
  it('includes Bearer token from BEARER_TOKEN env', () => {
    expect(authHeaders()).toEqual({ Authorization: `Bearer ${BEARER_TOKEN}` })
  })

  it('returns empty headers when BEARER_TOKEN is empty', () => {
    bearerToken = ''
    expect(authHeaders()).toEqual({})
    bearerToken = 'test-bearer-xyz' // restore for subsequent tests
  })
})

// ── resolveBaseUrl ordering ───────────────────────────────────────────

describe('resolveBaseUrl', () => {
  it('returns CLAUDE_API singleton when no profile is set anywhere', async () => {
    vi.mocked(getActiveProfileContext).mockReturnValue(null as any)
    vi.mocked(getActiveProfileName).mockReturnValue(null as any)
    const url = await resolveBaseUrl()
    expect(url).toBe('http://127.0.0.1:8642')
    expect(resolveGatewayHttpUrl).not.toHaveBeenCalled()
  })

  it('resolves explicit profileName via gateway-pool', async () => {
    vi.mocked(resolveGatewayHttpUrl).mockResolvedValue('http://sage-gw:9999')
    const url = await resolveBaseUrl('sage')
    expect(url).toBe('http://sage-gw:9999')
    expect(resolveGatewayHttpUrl).toHaveBeenCalledWith('sage')
  })

  it('uses AsyncLocalStorage context when no explicit profileName', async () => {
    vi.mocked(getActiveProfileContext).mockReturnValue('jarvis')
    vi.mocked(resolveGatewayHttpUrl).mockResolvedValue('http://jarvis-gw:9999')
    const url = await resolveBaseUrl()
    expect(url).toBe('http://jarvis-gw:9999')
    expect(resolveGatewayHttpUrl).toHaveBeenCalledWith('jarvis')
  })

  it('falls back to active-profile file when context is empty', async () => {
    vi.mocked(getActiveProfileContext).mockReturnValue(null as any)
    vi.mocked(getActiveProfileName).mockReturnValue('forge')
    vi.mocked(resolveGatewayHttpUrl).mockResolvedValue('http://forge-gw:9999')
    const url = await resolveBaseUrl()
    expect(url).toBe('http://forge-gw:9999')
    expect(resolveGatewayHttpUrl).toHaveBeenCalledWith('forge')
  })

  it('falls back to CLAUDE_API singleton on ProfileNotFoundError when implicit', async () => {
    vi.mocked(getActiveProfileContext).mockReturnValue('missing-profile')
    vi.mocked(resolveGatewayHttpUrl).mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'ProfileNotFoundError' }),
    )
    const url = await resolveBaseUrl()
    expect(url).toBe('http://127.0.0.1:8642')
  })

  it('propagates ProfileNotFoundError when caller named the profile explicitly', async () => {
    const err = Object.assign(new Error('not found'), {
      name: 'ProfileNotFoundError',
    })
    vi.mocked(resolveGatewayHttpUrl).mockRejectedValue(err)
    await expect(resolveBaseUrl('does-not-exist')).rejects.toBe(err)
  })

  it('propagates non-ProfileNotFoundError errors (e.g. GatewayNotRunningError)', async () => {
    const err = new Error('gateway down')
    vi.mocked(resolveGatewayHttpUrl).mockRejectedValue(err)
    await expect(resolveBaseUrl('sage')).rejects.toBe(err)
  })
})

// ── withProfile ───────────────────────────────────────────────────────

describe('withProfile', () => {
  it('runs fn directly when no profileName', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    const result = await withProfile(undefined, fn)
    expect(result).toBe('result')
    expect(withActiveProfile).not.toHaveBeenCalled()
  })

  it('runs fn inside withActiveProfile when profileName provided', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    vi.mocked(withActiveProfile).mockImplementation(async (_name, inner) => inner())
    const result = await withProfile('sage', fn)
    expect(result).toBe('result')
    expect(withActiveProfile).toHaveBeenCalledWith('sage', fn)
  })
})

// ── HTTP verbs ────────────────────────────────────────────────────────

describe('hermesGet', () => {
  it('sends GET with auth header and parses JSON', async () => {
    fetchResponses.push({ ok: true, status: 200, bodyJson: { hello: 'world' } })
    const out = await hermesGet<{ hello: string }>('/api/foo', 'sage')
    expect(out).toEqual({ hello: 'world' })
    expect(fetchCalls[0].url).toBe('http://gw:9999/api/foo')
    expect(fetchCalls[0].init?.method).toBeUndefined()
    expect(fetchCalls[0].init?.headers).toEqual({
      Authorization: 'Bearer test-bearer-xyz',
    })
  })

  it('throws on non-ok response with status and body in the message', async () => {
    fetchResponses.push({ ok: false, status: 500, bodyText: 'kaboom' })
    await expect(hermesGet('/api/foo', 'sage')).rejects.toThrow(
      /GET \/api\/foo: 500 kaboom/,
    )
  })
})

describe('hermesPost', () => {
  it('sends POST with JSON body when body provided', async () => {
    fetchResponses.push({ ok: true, status: 200, bodyJson: { id: 1 } })
    const out = await hermesPost<{ id: number }>(
      '/api/foo',
      { name: 'x' },
      'sage',
    )
    expect(out).toEqual({ id: 1 })
    const init = fetchCalls[0].init as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'x' }))
    expect(init.headers).toEqual({
      Authorization: 'Bearer test-bearer-xyz',
      'Content-Type': 'application/json',
    })
  })

  it('omits body when none provided', async () => {
    fetchResponses.push({ ok: true, status: 200, bodyJson: {} })
    await hermesPost('/api/foo', undefined, 'sage')
    const init = fetchCalls[0].init as RequestInit
    expect(init.body).toBeUndefined()
  })

  it('throws on non-ok response', async () => {
    fetchResponses.push({ ok: false, status: 400, bodyText: 'bad' })
    await expect(
      hermesPost('/api/foo', { x: 1 }, 'sage'),
    ).rejects.toThrow(/POST \/api\/foo: 400 bad/)
  })
})

describe('hermesPatch', () => {
  it('sends PATCH with JSON body', async () => {
    fetchResponses.push({ ok: true, status: 200, bodyJson: { ok: true } })
    await hermesPatch('/api/foo', { title: 'new' }, 'sage')
    const init = fetchCalls[0].init as RequestInit
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe(JSON.stringify({ title: 'new' }))
  })

  it('throws on non-ok response', async () => {
    fetchResponses.push({ ok: false, status: 422, bodyText: 'invalid' })
    await expect(
      hermesPatch('/api/foo', { x: 1 }, 'sage'),
    ).rejects.toThrow(/PATCH \/api\/foo: 422 invalid/)
  })
})

describe('hermesDelete', () => {
  it('sends DELETE and resolves on 200', async () => {
    fetchResponses.push({ ok: true, status: 204 })
    await expect(hermesDelete('/api/foo/1', 'sage')).resolves.toBeUndefined()
    const init = fetchCalls[0].init as RequestInit
    expect(init.method).toBe('DELETE')
  })

  it('throws on non-ok response', async () => {
    fetchResponses.push({ ok: false, status: 404, bodyText: 'gone' })
    await expect(hermesDelete('/api/foo/1', 'sage')).rejects.toThrow(
      /DELETE \/api\/foo\/1: 404 gone/,
    )
  })
})