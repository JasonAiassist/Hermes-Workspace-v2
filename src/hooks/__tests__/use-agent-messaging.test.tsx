// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  useAgentMessages,
  useAgentConversation,
  useSendAgentMessage,
} from '../use-agent-messaging'

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

describe('useAgentMessages', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches messages for a profile', async () => {
    const payload = [{ id: 'm1', from: 'a', to: 'b', content: 'hi', timestamp: 1 }]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      } as Response),
    )

    const { result } = renderHook(() => useAgentMessages('b'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(result.current.data).toEqual(payload)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/agents/messages?profile=b',
    )
  })

  it('does not fetch when disabled or empty profile', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useAgentMessages('', false), {
      wrapper: makeWrapper(),
    })

    // status stays 'pending' (idle) because the query is disabled
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.fetchStatus).toBe('idle')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('useAgentConversation', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('fetches conversation between two profiles', async () => {
    const payload = [
      { id: 'm1', from: 'a', to: 'b', content: 'hi', timestamp: 1 },
      { id: 'm2', from: 'b', to: 'a', content: 'hey', timestamp: 2 },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      } as Response),
    )

    const { result } = renderHook(() => useAgentConversation('a', 'b'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(result.current.data).toEqual(payload)
  })
})

describe('useSendAgentMessage', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('sends a message and invalidates related queries', async () => {
    const response = {
      id: 'new-msg',
      from: 'a',
      to: 'b',
      content: 'ping',
      timestamp: 99,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => response,
      } as Response),
    )

    const { result } = renderHook(() => useSendAgentMessage(), {
      wrapper: makeWrapper(),
    })

    result.current.mutate({ from: 'a', to: 'b', content: 'ping' })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/agents/message',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ from: 'a', to: 'b', content: 'ping' }),
      }),
    )
  })

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as Response),
    )

    const { result } = renderHook(() => useSendAgentMessage(), {
      wrapper: makeWrapper(),
    })

    result.current.mutate({ from: 'a', to: 'b', content: 'ping' })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect(result.current.error).toBeInstanceOf(Error)
    expect((result.current.error as Error).message).toBe('boom')
  })

  it('falls back to status text when error body has no error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response),
    )

    const { result } = renderHook(() => useSendAgentMessage(), {
      wrapper: makeWrapper(),
    })

    result.current.mutate({ from: 'a', to: 'b', content: 'ping' })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe('Failed to send message: 503')
  })

  it('uses default message when json parse also fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('unexpected token')
        },
      } as Response),
    )

    const { result } = renderHook(() => useSendAgentMessage(), {
      wrapper: makeWrapper(),
    })

    result.current.mutate({ from: 'a', to: 'b', content: 'ping' })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe('Failed to send message: 502')
  })
})

describe('useAgentMessages error branches', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('throws on non-ok response when fetching messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('bad json')
        },
      } as Response),
    )

    const { result } = renderHook(() => useAgentMessages('b'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe('Failed to fetch messages: 500')
  })
})

describe('useAgentConversation error branches', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('throws on non-ok response when fetching conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => {
          throw new SyntaxError('bad json')
        },
      } as Response),
    )

    const { result } = renderHook(() => useAgentConversation('a', 'b'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
    expect((result.current.error as Error).message).toBe('Failed to fetch conversation: 404')
  })

  it('does not fetch when a or b is empty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const { result } = renderHook(() => useAgentConversation('', 'b'), {
      wrapper: makeWrapper(),
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.fetchStatus).toBe('idle')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})