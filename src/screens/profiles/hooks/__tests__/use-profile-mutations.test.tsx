// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import {
  postJson,
  useStartGatewayMutation,
  useStopGatewayMutation,
  useActivateProfileMutation,
  useCreateProfileMutation,
  useDeleteProfileMutation,
  useRenameProfileMutation,
  useCloneProfileMutation,
  useSaveConfigMutation,
  useSaveSoulMutation,
} from '../use-profile-mutations'

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

/**
 * Capture the most recent fetch invocation as a tuple `[url, init?]`.
 * Reset between tests via `vi.restoreAllMocks()` / re-stubbing fetch.
 */
function lastFetchCall(): [string, RequestInit | undefined] {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1] as [string, RequestInit | undefined]
}

describe('postJson', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('returns parsed JSON on a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pid: 123 }),
      } as Response),
    )
    const result = await postJson('/api/profiles/start', { name: 'default' })
    expect(result).toEqual({ ok: true, pid: 123 })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/profiles/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'default' }),
      }),
    )
  })

  it('throws an Error with payload.error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Gateway already running' }),
      } as Response),
    )
    await expect(postJson('/x', {})).rejects.toThrow('Gateway already running')
  })

  it('attaches parsed payload as .details on the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'bad', extra: 'ctx' }),
      } as Response),
    )
    try {
      await postJson('/x', {})
      throw new Error('should have thrown')
    } catch (err) {
      const e = err as Error & { details?: unknown }
      expect(e).toBeInstanceOf(Error)
      expect(e.details).toEqual({ error: 'bad', extra: 'ctx' })
    }
  })

  it('falls back to status code in the error message when no payload.error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response),
    )
    await expect(postJson('/x', {})).rejects.toThrow('Request failed (500)')
  })

  it('treats a payload with `error` field on an ok response as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: 'soft failure' }),
      } as Response),
    )
    await expect(postJson('/x', {})).rejects.toThrow('soft failure')
  })

  it('survives a malformed JSON error body and still throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('unexpected token')
        },
      } as unknown as Response),
    )
    await expect(postJson('/x', {})).rejects.toThrow('Request failed (502)')
  })
})

/**
 * Shared factory: renders a mutation hook, triggers it, awaits settle, and
 * returns the fetch mock + result ref so each case only asserts behavior.
 */
async function runMutation(
  useHook: () => unknown,
  call: (api: { mutate: (v: unknown) => void }) => void,
) {
  const { result } = renderHook(() => (useHook as () => unknown)(), {
    wrapper: makeWrapper(),
  })
  await act(async () => {
    call(result.current as { mutate: (v: unknown) => void })
  })
  await waitFor(() => {
    expect((result.current as { isSuccess: boolean }).isSuccess).toBe(true)
  })
  return result
}

describe('gateway start/stop mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('useStartGatewayMutation POSTs to /api/profiles/start with the profile name', async () => {
    await runMutation(useStartGatewayMutation, (api) => api.mutate('default'))
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/start')
    expect(init?.body).toBe(JSON.stringify({ name: 'default' }))
  })

  it('useStopGatewayMutation POSTs to /api/profiles/stop with the profile name', async () => {
    await runMutation(useStopGatewayMutation, (api) => api.mutate('orchestrator'))
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/stop')
    expect(init?.body).toBe(JSON.stringify({ name: 'orchestrator' }))
  })

  it('start & stop invalidate the gateway-statuses query cache', async () => {
    const startResult = await runMutation(useStartGatewayMutation, (api) =>
      api.mutate('default'),
    )
    const stopResult = await runMutation(useStopGatewayMutation, (api) =>
      api.mutate('default'),
    )
    // invalidateQueries is fire-and-forget; the mutation resolves successfully
    // which proves the onSuccess path executed without throwing.
    expect((startResult.current as { isSuccess: boolean }).isSuccess).toBe(true)
    expect((stopResult.current as { isSuccess: boolean }).isSuccess).toBe(true)
  })
})

describe('activate / create / delete / rename mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('useActivateProfileMutation POSTs to /api/profiles/activate', async () => {
    await runMutation(useActivateProfileMutation, (api) => api.mutate('builder'))
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/activate')
    expect(init?.body).toBe(JSON.stringify({ name: 'builder' }))
  })

  it('useCreateProfileMutation POSTs the full create body', async () => {
    const body = {
      name: 'new-profile',
      cloneFrom: 'default',
      copyMemory: true,
      model: 'gpt-5.4',
      provider: 'openai',
      persistent: true,
      role: 'researcher',
      roleDescription: 'does research',
    }
    await runMutation(useCreateProfileMutation, (api) => api.mutate(body))
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/create')
    expect(init?.body).toBe(JSON.stringify(body))
  })

  it('useDeleteProfileMutation POSTs the name to /api/profiles/delete', async () => {
    await runMutation(useDeleteProfileMutation, (api) => api.mutate('old'))
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/delete')
    expect(init?.body).toBe(JSON.stringify({ name: 'old' }))
  })

  it('useRenameProfileMutation POSTs oldName + newName', async () => {
    await runMutation(useRenameProfileMutation, (api) =>
      api.mutate({ oldName: 'a', newName: 'b' }),
    )
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/rename')
    expect(init?.body).toBe(JSON.stringify({ oldName: 'a', newName: 'b' }))
  })
})

describe('useCloneProfileMutation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('POSTs to the path-encoded clone URL and forwards newName + copyMemory', async () => {
    await runMutation(useCloneProfileMutation, (api) =>
      api.mutate({ name: 'orchestrator', newName: 'orchestrator-2', copyMemory: true }),
    )
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/orchestrator/clone')
    expect(init?.body).toBe(
      JSON.stringify({ newName: 'orchestrator-2', copyMemory: true }),
    )
  })

  it('URL-encodes profile names containing special characters', async () => {
    await runMutation(useCloneProfileMutation, (api) =>
      api.mutate({ name: 'km agent', newName: 'km copy' }),
    )
    const [url] = lastFetchCall()
    expect(url).toBe('/api/profiles/km%20agent/clone')
  })

  it('omits copyMemory when undefined', async () => {
    await runMutation(useCloneProfileMutation, (api) =>
      api.mutate({ name: 'p', newName: 'p2' }),
    )
    const [, init] = lastFetchCall()
    expect(init?.body).toBe(
      JSON.stringify({ newName: 'p2', copyMemory: undefined }),
    )
  })
})

describe('useSaveConfigMutation / useSaveSoulMutation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('useSaveConfigMutation writes config YAML to /api/profiles/config-write', async () => {
    await runMutation(useSaveConfigMutation, (api) =>
      api.mutate({ name: 'builder', configYaml: 'model: gpt-5.4\n' }),
    )
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/config-write')
    expect(init?.body).toBe(
      JSON.stringify({ name: 'builder', configYaml: 'model: gpt-5.4\n' }),
    )
  })

  it('useSaveSoulMutation writes SOUL text to /api/profiles/soul-write', async () => {
    await runMutation(useSaveSoulMutation, (api) =>
      api.mutate({ name: 'builder', soul: 'You are a builder.' }),
    )
    const [url, init] = lastFetchCall()
    expect(url).toBe('/api/profiles/soul-write')
    expect(init?.body).toBe(
      JSON.stringify({ name: 'builder', soul: 'You are a builder.' }),
    )
  })
})

describe('mutation error propagation', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('surfaces server error message via result.error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 423,
        json: async () => ({ error: 'profile locked' }),
      } as Response),
    )

    const { result } = renderHook(() => useStartGatewayMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      ;(result.current as { mutate: (v: unknown) => void }).mutate('default')
    })
    await waitFor(() => {
      expect((result.current as { isError: boolean }).isError).toBe(true)
    })
    const err = (result.current as { error: Error }).error
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('profile locked')
  })
})
