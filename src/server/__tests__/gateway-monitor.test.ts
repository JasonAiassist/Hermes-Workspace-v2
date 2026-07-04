/**
 * Gateway monitor tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startMonitoring,
  stopMonitoring,
  isMonitoring,
} from '../gateway-monitor'
import {
  getAllMonitorStates,
  getMonitorState,
  resetMonitorState,
} from '../gateway-monitor-state'
import * as registry from '../gateway-registry'
import * as orchestrator from '../gateway-orchestrator'
import * as health from '../gateway-health'

vi.mock('../gateway-registry', () => ({
  readGatewayRegistry: vi.fn(),
  isProcessAlive: vi.fn(),
}))

vi.mock('../gateway-orchestrator', () => ({
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  getGatewayStatus: vi.fn(),
}))

vi.mock('../gateway-health', () => ({
  probeGateway: vi.fn(),
}))

const mockReadRegistry = vi.mocked(registry.readGatewayRegistry)
const mockIsProcessAlive = vi.mocked(registry.isProcessAlive)
const mockStartGateway = vi.mocked(orchestrator.startGateway)
const mockStopGateway = vi.mocked(orchestrator.stopGateway)
const mockProbeGateway = vi.mocked(health.probeGateway)

describe('gateway-monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stopMonitoring()
    // Clear any lingering restart state from previous tests (stopMonitoring
    // intentionally persists failure history, but tests need a clean slate).
    getAllMonitorStates().forEach((s) => resetMonitorState(s.profile))
    vi.clearAllMocks()
    mockReadRegistry.mockReturnValue({ version: 1, entries: {} })
  })

  afterEach(() => {
    stopMonitoring()
    vi.useRealTimers()
  })

  it('starts and stops', () => {
    expect(isMonitoring()).toBe(false)
    startMonitoring()
    expect(isMonitoring()).toBe(true)
    stopMonitoring()
    expect(isMonitoring()).toBe(false)
  })

  it('does not double-start', () => {
    startMonitoring()
    startMonitoring()
    expect(isMonitoring()).toBe(true)
  })

  it('checks healthy gateway and leaves it alone', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 12 })

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)
    stopMonitoring()

    expect(mockProbeGateway).toHaveBeenCalledWith(8642)
    expect(mockStartGateway).not.toHaveBeenCalled()
    expect(mockStopGateway).not.toHaveBeenCalled()
  })

  it('restarts unhealthy gateway after backoff', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: false, error: 'timeout' })
    mockStartGateway.mockResolvedValue({ httpPort: 8642, wsPort: 18789, pid: 12346 })
    mockStopGateway.mockResolvedValue(undefined)

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)

    // Monitor should have detected unhealthy and scheduled restart
    const stateBefore = getMonitorState('sage')
    expect(stateBefore?.state).toBe('restarting')

    // Advance through the first backoff (5s)
    await vi.advanceTimersByTimeAsync(5000)

    expect(mockStopGateway).toHaveBeenCalledWith('sage')
    expect(mockStartGateway).toHaveBeenCalledWith('sage')

    const stateAfter = getMonitorState('sage')
    expect(stateAfter?.state).toBe('healthy')
    stopMonitoring()
  })

  it('deduplicates concurrent restart attempts', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: false, error: 'timeout' })
    // Make startGateway take 60s so the lock stays held across the next cycle
    mockStartGateway.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ httpPort: 8642, wsPort: 18789, pid: 12346 }), 60_000)),
    )
    mockStopGateway.mockResolvedValue(undefined)

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50) // first cycle triggers restart

    // tryRestartGateway is now holding the lock with 5s backoff
    expect(mockStartGateway).not.toHaveBeenCalled()

    // Complete the first backoff (5s) — startGateway is now "in flight" for 60s
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockStartGateway).toHaveBeenCalledTimes(1)

    // Trigger second cycle while startGateway is still in flight
    await vi.advanceTimersByTimeAsync(30_000)
    // startGateway should still have been called only once (dedup)
    expect(mockStartGateway).toHaveBeenCalledTimes(1)

    // Complete the in-flight startGateway (60s total)
    await vi.advanceTimersByTimeAsync(60_000)

    // Lock is now released. Simulate the gateway becoming unhealthy again.
    mockProbeGateway.mockResolvedValue({ healthy: false, error: 'timeout' })
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(5000)
    // A NEW restart should be allowed now
    expect(mockStartGateway).toHaveBeenCalledTimes(2)

    stopMonitoring()
  })

  it('restarts gateway with dead process after backoff', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(false)
    mockStartGateway.mockResolvedValue({ httpPort: 8642, wsPort: 18789, pid: 12346 })
    mockStopGateway.mockResolvedValue(undefined)

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)

    const stateBefore = getMonitorState('sage')
    expect(stateBefore?.state).toBe('restarting')

    await vi.advanceTimersByTimeAsync(5000)

    expect(mockStopGateway).toHaveBeenCalledWith('sage')
    expect(mockStartGateway).toHaveBeenCalledWith('sage')
    stopMonitoring()
  })

  it('marks gateway failed after max restarts', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(false)
    mockStartGateway.mockRejectedValue(new Error('spawn failed'))
    mockStopGateway.mockResolvedValue(undefined)

    startMonitoring()

    // First check (immediate) → first restart (backoff 5s)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockStartGateway).toHaveBeenCalledTimes(1)

    // Wait for next monitor cycle (30s interval) → second restart (backoff 30s)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockStartGateway).toHaveBeenCalledTimes(2)

    // Wait for next monitor cycle (30s interval) → third restart (backoff 120s)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockStartGateway).toHaveBeenCalledTimes(3)

    // The third restart is still in-flight when the next interval fires at t=180s.
    // Wait one more cycle so the dedup lock is released and state becomes 'failed'.
    await vi.advanceTimersByTimeAsync(30_000)

    // After 3 failures, state should be 'failed' and no more restarts
    const state = getMonitorState('sage')
    expect(state?.state).toBe('failed')
    expect(state?.attempts).toBe(3)

    // Advance further — no 4th call
    await vi.advanceTimersByTimeAsync(150_000)
    expect(mockStartGateway).toHaveBeenCalledTimes(3)

    stopMonitoring()
  })

  it('does not restart after stopMonitoring is called during backoff', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(false)
    mockStartGateway.mockResolvedValue({ httpPort: 8642, wsPort: 18789, pid: 12346 })
    mockStopGateway.mockResolvedValue(undefined)

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)

    // Stop monitoring during the backoff delay
    stopMonitoring()

    // Advance past the backoff — startGateway should NOT be called
    await vi.advanceTimersByTimeAsync(5000)
    expect(mockStartGateway).not.toHaveBeenCalled()
  })

  it('resets monitor state', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 12 })

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)

    resetMonitorState('sage')
    const state = getMonitorState('sage')
    expect(state?.state).toBe('healthy')
    expect(state?.attempts).toBe(0)
    stopMonitoring()
  })

  it('getAllMonitorStates returns populated states after cycle', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8642, wsPort: 18789, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 12 })

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)
    const states = getAllMonitorStates()
    expect(states.length).toBe(1)
    expect(states[0].profile).toBe('sage')
    expect(states[0].lastProbe).toBeDefined()
    stopMonitoring()
  })

  it('survives error in initial monitor cycle', async () => {
    mockReadRegistry.mockImplementation(() => {
      throw new Error('registry corrupt')
    })
    expect(() => startMonitoring()).not.toThrow()
    await vi.advanceTimersByTimeAsync(50)
    stopMonitoring()
  })

  it('isolates per-gateway errors so one bad gateway does not starve others', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        bad: { httpPort: 8642, wsPort: 18789, pid: 11111, startedAt: Date.now() },
        good: { httpPort: 8643, wsPort: 18790, pid: 22222, startedAt: Date.now() },
      },
    })
    // First call (bad gateway) throws; second call (good gateway) is alive and healthy
    mockIsProcessAlive
      .mockImplementationOnce(() => {
        throw new Error('procfs denied')
      })
      .mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 12 })

    startMonitoring()
    await vi.advanceTimersByTimeAsync(50)

    // good gateway was still checked and probed
    expect(mockProbeGateway).toHaveBeenCalledWith(8643)
    const goodState = getMonitorState('good')
    expect(goodState?.state).toBe('healthy')

    stopMonitoring()
  })
})
