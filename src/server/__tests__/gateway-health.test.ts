import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { probeGateway } from '../gateway-health'

describe('probeGateway', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns healthy when /health responds with 200', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))

    const result = await probeGateway(8642)

    expect(result.healthy).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/health',
      expect.any(Object),
    )
  })

  it('falls back to /api/health when /health fails', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const result = await probeGateway(8642)

    expect(result.healthy).toBe(true)
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8642/health',
      expect.any(Object),
    )
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8642/api/health',
      expect.any(Object),
    )
  })

  it('falls back to /api/sessions as proxy when health endpoints fail', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))

    const result = await probeGateway(8642)

    expect(result.healthy).toBe(true)
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8642/api/sessions',
      expect.any(Object),
    )
  })

  it('returns unhealthy when all endpoints fail', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not found', { status: 404 }))

    const result = await probeGateway(8642)

    expect(result.healthy).toBe(false)
    expect((result as any).error).toContain('404')
  })

  it('returns unhealthy on fetch timeout', async () => {
    const perfNowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('The operation was aborted')
          ;(err as any).name = 'AbortError'
          reject(err)
        }
        if ((opts as any)?.signal?.aborted) {
          onAbort()
          return
        }
        ;(opts as any)?.signal?.addEventListener('abort', onAbort)
      })
    })

    const promise = probeGateway(8642, 100)
    vi.advanceTimersByTime(500)
    const result = await promise

    expect(result.healthy).toBe(false)
    expect((result as any).error).toBe('timeout')
    perfNowSpy.mockRestore()
  })

  it('returns unhealthy on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))

    const result = await probeGateway(8642)

    expect(result.healthy).toBe(false)
    expect((result as any).error).toContain('Connection refused')
  })

  it('uses the provided port in the URL', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))

    await probeGateway(9999)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/health',
      expect.any(Object),
    )
  })

  it('uses custom timeout when provided', async () => {
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error('aborted')
          ;(err as any).name = 'AbortError'
          reject(err)
        }
        if ((opts as any)?.signal?.aborted) {
          onAbort()
          return
        }
        ;(opts as any)?.signal?.addEventListener('abort', onAbort)
      })
    })

    const promise = probeGateway(8642, 50)
    vi.advanceTimersByTime(300)
    const result = await promise

    expect(result.healthy).toBe(false)
    expect((result as any).error).toBe('timeout')
  })
})
