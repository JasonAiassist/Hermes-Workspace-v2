// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import {
  useProfileGatewayStatuses,
  type ProfileStatusesResponse,
} from '../use-profile-gateway-status'

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

const statusesFixture: Record<string, ProfileStatusesResponse['statuses'][string]> = {
  default: {
    status: 'healthy',
    pid: 4242,
    ports: { http: 8642, ws: 18789 },
    health: { latencyMs: 12 },
  },
  builder: {
    status: 'unhealthy',
    pid: 5000,
    ports: { http: 8643, ws: 18790 },
    health: { latencyMs: 0, error: 'ECONNREFUSED' },
  },
  stopped: { status: 'stopped' },
}

describe('useProfileGatewayStatuses', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('fetches GET /api/profiles/status-all and returns the statuses map', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, statuses: statusesFixture }),
      } as Response),
    )

    const { result } = renderHook(() => useProfileGatewayStatuses(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(result.current.data).toEqual(statusesFixture)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/profiles/status-all')
  })

  it('configures a 5s refetchInterval for live polling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, statuses: {} }),
      } as Response),
    )

    // Build the wrapper with a captured QueryClient so we can inspect the
    // cached Query options (useQuery options land on the Query object).
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )

    renderHook(() => useProfileGatewayStatuses(), { wrapper })

    await waitFor(() => {
      expect(
        qc.getQueryCache().find({
          queryKey: ['profiles', 'gateway-statuses'],
        }),
      ).toBeTruthy()
    })
    const query = qc.getQueryCache().find({
      queryKey: ['profiles', 'gateway-statuses'],
    })
    // react-query stores useQuery options (incl. refetchInterval) on the Query.
    const opts = query?.options as { refetchInterval?: number }
    expect(opts?.refetchInterval).toBe(5_000)
  })

  it('throws when the endpoint returns a non-2xx response, surfacing the body text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'internal explosion',
      } as Response),
    )

    const { result } = renderHook(() => useProfileGatewayStatuses(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe('internal explosion')
  })

  it('falls back to a status-coded message when the error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => '',
      } as Response),
    )

    const { result } = renderHook(() => useProfileGatewayStatuses(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe(
      'Status fetch failed (503)',
    )
  })

  it('survives a text() rejection and still throws the status-coded message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error('stream already consumed')
        },
      } as unknown as Response),
    )

    const { result } = renderHook(() => useProfileGatewayStatuses(), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe(
      'Status fetch failed (502)',
    )
  })
})

describe('use-profile-gateway-status re-exports', () => {
  it('re-exports useStartGatewayMutation and useStopGatewayMutation', async () => {
    const mod = await import('../use-profile-gateway-status')
    expect(typeof mod.useStartGatewayMutation).toBe('function')
    expect(typeof mod.useStopGatewayMutation).toBe('function')
  })
})
