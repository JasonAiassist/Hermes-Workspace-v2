import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { getProfileHermesHome } from '../gateway-registry'

/* —— hoisted mocks —— */
const mockSpawn = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockProbeGateway = vi.hoisted(() => vi.fn())

// Shared mutable registry so sequential startGateway calls see previous writes
const { sharedRegistry, mockReadRegistry, mockWriteRegistry, mockGetEntry, mockSetEntry, mockRemoveEntry } = vi.hoisted(() => {
  const sharedRegistry = { version: 1, entries: {} as Record<string, unknown> }
  return {
    sharedRegistry,
    mockReadRegistry: vi.fn().mockReturnValue(sharedRegistry),
    mockWriteRegistry: vi.fn(),
    mockGetEntry: vi.fn().mockImplementation((reg: any, name: string) => reg.entries[name]),
    mockSetEntry: vi.fn().mockImplementation((reg: any, name: string, entry: unknown) => {
      reg.entries[name] = entry
    }),
    mockRemoveEntry: vi.fn().mockImplementation((reg: any, name: string) => {
      delete reg.entries[name]
    }),
  }
})
const mockIsProcessAlive = vi.hoisted(() => vi.fn())
const mockResolveHermesBinary = vi.hoisted(() =>
  vi.fn().mockReturnValue('/usr/local/bin/hermes'),
)
const mockResolveHermesAgentDir = vi.hoisted(() =>
  vi.fn().mockReturnValue('/opt/hermes-agent'),
)
const mockResolveHermesPython = vi.hoisted(() =>
  vi.fn().mockReturnValue('/opt/hermes-agent/.venv/bin/python'),
)

const mockExecSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  default: { spawn: mockSpawn, execSync: mockExecSync },
  spawn: mockSpawn,
  execSync: mockExecSync,
}))

const mockReadFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../gateway-health', () => ({
  probeGateway: (...args: any[]) => mockProbeGateway(...args),
}))

vi.mock('../gateway-registry', () => ({
  readGatewayRegistry: () => mockReadRegistry(),
  writeGatewayRegistry: mockWriteRegistry,
  getRegistryEntry: (...args: any[]) => mockGetEntry(...args),
  setRegistryEntry: mockSetEntry,
  removeRegistryEntry: mockRemoveEntry,
  isProcessAlive: mockIsProcessAlive,
  initializeGatewayRegistry: vi.fn(),
  getProfileHermesHome: vi.fn().mockReturnValue('/tmp/hermes'),
}))

const mockGetProfileWorkspaceConfig = vi.hoisted(() => vi.fn().mockReturnValue({ persistent: false }))

vi.mock('../profile-workspace-config', () => ({
  getProfileWorkspaceConfig: (...args: any[]) => mockGetProfileWorkspaceConfig(...args),
}))
vi.mock('../hermes-agent', () => ({
  resolveHermesBinary: mockResolveHermesBinary,
  resolveHermesAgentDir: mockResolveHermesAgentDir,
  resolveHermesPython: mockResolveHermesPython,
  buildHermesPath: vi.fn().mockReturnValue('/tmp/hermes'),
}))

async function loadMod() {
  vi.resetModules()
  return import('../gateway-orchestrator')
}

function resetAllMocks() {
  vi.resetAllMocks()
  sharedRegistry.entries = {}
  mockReadRegistry.mockReturnValue(sharedRegistry)
  mockGetEntry.mockReset()
  mockGetEntry.mockImplementation((reg: any, name: string) => reg.entries[name])
  mockSetEntry.mockImplementation((reg: any, name: string, entry: unknown) => {
    reg.entries[name] = entry
  })
  mockRemoveEntry.mockImplementation((reg: any, name: string) => {
    delete reg.entries[name]
  })
  mockResolveHermesBinary.mockReturnValue('/usr/local/bin/hermes')
  mockResolveHermesAgentDir.mockReturnValue('/opt/hermes-agent')
  mockResolveHermesPython.mockReturnValue('/opt/hermes-agent/.venv/bin/python')
  mockGetProfileWorkspaceConfig.mockReturnValue({ persistent: false })
  vi.mocked(getProfileHermesHome).mockReturnValue('/tmp/hermes')
  mockProbeGateway.mockResolvedValue({ healthy: false, error: 'mock-default-unhealthy' })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test: no external gateway')))
}

/* ── startGateway ── */
describe('startGateway', () => {
  let mockProcess: EventEmitter & Partial<ChildProcess>

  beforeEach(async () => {
    resetAllMocks()
    process.env.HERMES_TEST_SPAWN_TIMEOUT_MS = '100'
    process.env.HERMES_TEST_SKIP_WS_VERIFY = '1'
    process.env.HERMES_TEST_POLL_INTERVAL_MS = '10'

    const { EventEmitter } = await import('node:events')
    mockProcess = Object.assign(new EventEmitter(), {
      pid: 12345,
      kill: vi.fn(),
      unref: vi.fn(),
    }) as unknown as EventEmitter & Partial<ChildProcess>

    mockExistsSync.mockReturnValue(true)
    mockSpawn.mockReturnValue(mockProcess as ChildProcess)
    mockIsProcessAlive.mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env.HERMES_TEST_SPAWN_TIMEOUT_MS
    delete process.env.HERMES_TEST_SKIP_WS_VERIFY
    delete process.env.HERMES_TEST_POLL_INTERVAL_MS
  })

  it('returns existing allocation when gateway is already running and healthy', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 42 })

    const mod = await loadMod()
    const result = await mod.startGateway('sage')

    expect(result).toEqual({ httpPort: 8643, wsPort: 18790, pid: 12345 })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('kills and respawns when existing process is alive but unhealthy', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    // First call probes existing (unhealthy), second call probes respawned (healthy)
    mockProbeGateway
      .mockResolvedValueOnce({ healthy: false, error: 'Timeout', latencyMs: 100 })
      .mockResolvedValueOnce({ healthy: true, latencyMs: 50 })

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    const startPromise = mod.startGateway('sage')
    const result = await startPromise

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(result.pid).toBe(12345)
    killSpy.mockRestore()
  })

  it('rejects concurrent start requests for the same profile', async () => {
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 42 })
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })

    const mod = await loadMod()
    // First call holds the lock because probeGateway is async
    const first = mod.startGateway('sage')
    // Second call should be rejected immediately
    await expect(mod.startGateway('sage')).rejects.toThrow('already in progress')
    await first
  })

  it('spawns gateway process and writes registry', async () => {
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockProbeGateway.mockResolvedValueOnce({ healthy: false })
    const mod = await loadMod()

    const startPromise = mod.startGateway('default')
    const result = await startPromise

    expect(mockSpawn).toHaveBeenCalledOnce()
    const [command, args, opts] = mockSpawn.mock.calls[0]
    expect(command).toContain('hermes')
    expect(args).toContain('gateway')
    expect(args).toContain('run')
    expect(opts).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/tmp/hermes',
    })
    expect(opts.env).toBeDefined()
    expect(opts.env.HERMES_HOME).toBe('/tmp/hermes')

    expect(mockWriteRegistry).toHaveBeenCalled()
    expect(result.pid).toBe(12345)
    expect(result.httpPort).toBeGreaterThanOrEqual(8642)
    expect(result.httpPort).toBeLessThanOrEqual(8699)
    expect(result.wsPort).toBeGreaterThanOrEqual(18789)
    expect(result.wsPort).toBeLessThanOrEqual(18899)
  })

  it('adopts externally-managed gateway using profile API_SERVER_KEY', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    // Profile .env has its own API_SERVER_KEY
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/hermes/.env') {
        return 'API_SERVER_KEY=sage-profile-key\nMODEL=custom/kimi-k2.6\n'
      }
      throw new Error('ENOENT')
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'sage' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const mod = await loadMod()
    const result = await mod.startGateway('sage')

    expect(result.httpPort).toBe(8642)
    expect(result.pid).toBe(-1)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockWriteRegistry).toHaveBeenCalled()

    // Must use profile's own API key, not workspace token
    const authHeader = mockFetch.mock.calls[0][1]?.headers?.Authorization
    expect(authHeader).toBe('Bearer sage-profile-key')
  })

  it('adopts externally-managed gateway falling back to workspace token', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    // Profile .env has NO API key
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/hermes/.env') {
        return 'MODEL=custom/kimi-k2.6\n'
      }
      throw new Error('ENOENT')
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'sage' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)
    process.env.HERMES_API_TOKEN = 'workspace-token-123'

    const mod = await loadMod()
    const result = await mod.startGateway('sage')

    expect(result.httpPort).toBe(8642)
    expect(result.pid).toBe(-1)
    expect(mockSpawn).not.toHaveBeenCalled()

    // Falls back to workspace token
    const authHeader = mockFetch.mock.calls[0][1]?.headers?.Authorization
    expect(authHeader).toBe('Bearer workspace-token-123')

    delete process.env.HERMES_API_TOKEN
  })

  it('adopts externally-managed gateway with no auth when no keys exist', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/hermes/.env') {
        return 'MODEL=custom/kimi-k2.6\n'
      }
      throw new Error('ENOENT')
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'sage' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)
    delete process.env.HERMES_API_TOKEN

    const mod = await loadMod()
    const result = await mod.startGateway('sage')

    expect(result.httpPort).toBe(8642)
    expect(result.pid).toBe(-1)
    expect(mockSpawn).not.toHaveBeenCalled()

    // No auth header when no keys exist
    const authHeader = mockFetch.mock.calls[0][1]?.headers?.Authorization
    expect(authHeader).toBeUndefined()
  })

  it('spawns new gateway when external gateway model ID does not match', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    // findExternalGatewayPort probes many ports — all healthy but model mismatch
    // Then trySpawnGateway health check must also succeed
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/hermes/.env') {
        return 'API_SERVER_KEY=sage-key\n'
      }
      throw new Error('ENOENT')
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'some-other-profile' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const mod = await loadMod()
    const result = await mod.startGateway('sage')

    // Should spawn a new gateway since external one didn't match
    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(result.pid).toBe(12345)
  })

  it('throws when health probe never succeeds', async () => {
    mockProbeGateway.mockResolvedValue({
      healthy: false,
      error: 'Timeout',
      latencyMs: 1000,
    })

    const mod = await loadMod()
    await expect(mod.startGateway('default')).rejects.toThrow('failed health check')
  })

  it('throws when profile directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const mod = await loadMod()
    await expect(mod.startGateway('default')).rejects.toThrow(
      'Profile directory not found',
    )
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('retries on failed health check (TOCTOU mitigation)', async () => {
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockProbeGateway.mockResolvedValueOnce({ healthy: false })
    mockProbeGateway.mockResolvedValueOnce({ healthy: false, error: 'failed health check', latencyMs: 0 })

    const mod = await loadMod()
    const result = await mod.startGateway('default')

    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(result.pid).toBe(12345)
  })

  it('allocates distinct ports for concurrent startGateway calls', async () => {
    mockExistsSync.mockReturnValue(true)
    process.env.HERMES_TEST_SPAWN_TIMEOUT_MS = '100'
    process.env.HERMES_TEST_SKIP_WS_VERIFY = '1'

    const { EventEmitter } = await import('node:events')

    let spawnCount = 0
    mockSpawn.mockImplementation(() => {
      spawnCount += 1
      const proc = Object.assign(new EventEmitter(), {
        pid: 12344 + spawnCount,
        kill: vi.fn(),
        unref: vi.fn(),
      }) as unknown as ChildProcess
      return proc
    })

    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockIsProcessAlive.mockImplementation((pid: number) => pid >= 12345 && pid <= 12346)

    const mod = await loadMod()

    const [result1, result2] = await Promise.all([
      mod.startGateway('profile-a'),
      mod.startGateway('profile-b'),
    ])

    expect(result1.httpPort).not.toBe(result2.httpPort)
    // When using the hermes binary, WS port is always hardcoded to 18789
    expect(result1.wsPort).toBe(18789)
    expect(result2.wsPort).toBe(18789)

    delete process.env.HERMES_TEST_SPAWN_TIMEOUT_MS
    delete process.env.HERMES_TEST_SKIP_WS_VERIFY
  })

  it('routes allocated profile through target gateway without spawning', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockGetProfileWorkspaceConfig.mockReturnValue({ persistent: false, allocatedTo: 'sage' })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'sage' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const mod = await loadMod()
    const result = await mod.startGateway('allocated-profile')

    expect(result.httpPort).toBe(8642)
    expect(result.pid).toBe(-2)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockWriteRegistry).toHaveBeenCalled()
  })

  it('throws when allocated gateway is unreachable', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(true)
    mockProbeGateway.mockResolvedValue({ healthy: false, error: 'Connection refused' })
    mockGetProfileWorkspaceConfig.mockReturnValue({ persistent: false, allocatedTo: 'sage' })

    const mockFetch = vi.fn().mockRejectedValue(new Error('test: no external gateway'))
    vi.stubGlobal('fetch', mockFetch)

    const mod = await loadMod()
    await expect(mod.startGateway('allocated-profile')).rejects.toThrow(
      'Allocated gateway "sage" is not reachable',
    )
  })
})

/* ── getGatewayStatus ── */
describe('getGatewayStatus', () => {
  beforeEach(() => {
    resetAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('returns stopped when no registry entry exists', async () => {
    mockGetEntry.mockReturnValue(undefined)

    const mod = await loadMod()
    const status = await mod.getGatewayStatus('sage')

    expect(status.status).toBe('stopped')
  })

  it('adopts externally-managed gateway when no registry entry but gateway is running', async () => {
    mockGetEntry.mockReturnValue(undefined)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 42 })
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/tmp/hermes/.env') {
        return 'API_SERVER_KEY=sage-profile-key\n'
      }
      throw new Error('ENOENT')
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'sage' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const mod = await loadMod()
    const status = await mod.getGatewayStatus('sage')

    expect(status.status).toBe('healthy')
    expect(status.ports?.http).toBe(8642)
    expect(status.health?.latencyMs).toBe(42)
    expect(mockWriteRegistry).toHaveBeenCalled()

    // Uses profile's own API key
    const authHeader = mockFetch.mock.calls[0][1]?.headers?.Authorization
    expect(authHeader).toBe('Bearer sage-profile-key')
  })

  it('returns healthy when probe succeeds', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 42 })
    mockIsProcessAlive.mockReturnValue(true)

    const mod = await loadMod()
    const status = await mod.getGatewayStatus('sage')

    expect(status.status).toBe('healthy')
    expect(status.health?.latencyMs).toBe(42)
    expect(mockProbeGateway).toHaveBeenCalledWith(8643)
  })

  it('returns unhealthy when probe fails but process exists', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockProbeGateway.mockResolvedValue({
      healthy: false,
      error: 'Connection refused',
      latencyMs: 100,
    })
    mockIsProcessAlive.mockReturnValue(true)

    const mod = await loadMod()
    const status = await mod.getGatewayStatus('sage')

    expect(status.status).toBe('unhealthy')
    expect(status.health?.error).toBe('Connection refused')
  })

  it('cleans up stale registry entry when PID is dead', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockIsProcessAlive.mockReturnValue(false)

    const mod = await loadMod()
    const status = await mod.getGatewayStatus('sage')

    expect(status.status).toBe('stopped')
    expect(mockRemoveEntry).toHaveBeenCalled()
    expect(mockWriteRegistry).toHaveBeenCalled()
  })
})

/* ── stopGateway ── */
describe('stopGateway', () => {
  beforeEach(() => {
    resetAllMocks()
    process.env.HERMES_TEST_KILL_SIGTERM_MS = '20'
    process.env.HERMES_TEST_KILL_SIGKILL_MS = '20'
    process.env.HERMES_TEST_POLL_INTERVAL_MS = '5'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    delete process.env.HERMES_TEST_KILL_SIGTERM_MS
    delete process.env.HERMES_TEST_KILL_SIGKILL_MS
    delete process.env.HERMES_TEST_POLL_INTERVAL_MS
    vi.useRealTimers()
  })

  it('returns silently when no registry entry exists', async () => {
    mockGetEntry.mockReturnValue(undefined)

    const mod = await loadMod()
    await expect(mod.stopGateway('sage')).resolves.not.toThrow()
  })

  it('never calls process.kill for externally-managed entry (pid: -1)', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: -1,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: -1, startedAt: Date.now() },
      },
    })

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    await mod.stopGateway('sage')

    expect(killSpy).not.toHaveBeenCalled()
    expect(mockExecSync).toHaveBeenCalledWith(
      'systemctl --user stop hermes-gateway-sage.service',
      { stdio: 'ignore' },
    )
    expect(mockRemoveEntry).toHaveBeenCalled()
    expect(mockWriteRegistry).toHaveBeenCalled()

    killSpy.mockRestore()
  })

  it('kills process and cleans up registry', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    // Alive on first check, dead after SIGTERM
    mockIsProcessAlive.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(false)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    const promise = mod.stopGateway('sage')
    await vi.advanceTimersByTimeAsync(20)
    await promise

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    expect(mockWriteRegistry).toHaveBeenCalled()

    killSpy.mockRestore()
  })

  it('uses SIGKILL when SIGTERM fails', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    // Alive through SIGTERM and SIGKILL waits, but dead on final verification
    mockIsProcessAlive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    const promise = mod.stopGateway('sage')
    await vi.advanceTimersByTimeAsync(20)
    await promise

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL')
    expect(mockIsProcessAlive).toHaveBeenCalledTimes(7)

    killSpy.mockRestore()
  })

  it('throws when process survives SIGKILL', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    mockIsProcessAlive.mockReturnValue(true)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    const promise = mod.stopGateway('sage').catch((err: any) => err)
    await vi.advanceTimersByTimeAsync(40)
    const err = await promise
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('survived SIGKILL')

    killSpy.mockRestore()
  })

  it('rejects concurrent stop requests for the same profile', async () => {
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    // Keep alive during first stop
    mockIsProcessAlive.mockReturnValue(true)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const mod = await loadMod()

    // Start first stop but don't await
    const first = mod.stopGateway('sage')

    // Second should reject immediately
    await expect(mod.stopGateway('sage')).rejects.toThrow('already in progress')

    // Clean up: let SIGTERM succeed so first can finish
    mockIsProcessAlive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(20)
    killSpy.mockRestore()
    await first.catch(() => {}) // ignore
  })
})

/* — restartGateway — */
describe('restartGateway', () => {
  let mockProcess: EventEmitter & Partial<ChildProcess>

  beforeEach(async () => {
    resetAllMocks()
    process.env.HERMES_TEST_SPAWN_TIMEOUT_MS = '100'
    process.env.HERMES_TEST_KILL_SIGTERM_MS = '20'
    process.env.HERMES_TEST_KILL_SIGKILL_MS = '20'
    process.env.HERMES_TEST_POLL_INTERVAL_MS = '5'
    process.env.HERMES_TEST_SKIP_WS_VERIFY = '1'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const { EventEmitter } = await import('node:events')
    mockProcess = Object.assign(new EventEmitter(), {
      pid: 12345,
      kill: vi.fn(),
      unref: vi.fn(),
    }) as unknown as EventEmitter & Partial<ChildProcess>

    mockExistsSync.mockReturnValue(true)
    mockSpawn.mockReturnValue(mockProcess as ChildProcess)
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockIsProcessAlive.mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env.HERMES_TEST_SPAWN_TIMEOUT_MS
    delete process.env.HERMES_TEST_KILL_SIGTERM_MS
    delete process.env.HERMES_TEST_KILL_SIGKILL_MS
    delete process.env.HERMES_TEST_POLL_INTERVAL_MS
    delete process.env.HERMES_TEST_SKIP_WS_VERIFY
    vi.useRealTimers()
  })

  it('calls stopGateway then startGateway', async () => {
    const mod = await loadMod()
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    // Alive during stop, dead after SIGTERM, dead on final check, alive again for startGateway health check
    mockIsProcessAlive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const promise = mod.restartGateway('sage')
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise

    // stopGateway should have killed the process
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    // startGateway should have spawned a new process
    expect(mockSpawn).toHaveBeenCalled()

    killSpy.mockRestore()
  })

  it('clears monitor failure state before starting', async () => {
    const mod = await loadMod()
    const stateMod = await import('../gateway-monitor-state')

    // Seed a failed monitor state
    const rec = stateMod.getRecord('sage')
    rec.state = 'failed'
    rec.attempts = 3

    vi.spyOn(mod, 'stopGateway').mockResolvedValue(undefined)
    vi.spyOn(mod, 'startGateway').mockResolvedValue({
      httpPort: 8642,
      wsPort: 18789,
      pid: 12345,
    })

    await mod.restartGateway('sage')

    const afterState = stateMod.getMonitorState('sage')
    expect(afterState?.state).toBe('healthy')
    expect(afterState?.attempts).toBe(0)
  })

  it('proceeds to startGateway even when stopGateway throws and surfaces warning', async () => {
    const mod = await loadMod()
    mockGetEntry.mockReturnValue({
      httpPort: 8643,
      wsPort: 18790,
      pid: 12345,
      startedAt: Date.now(),
    })
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 12345, startedAt: Date.now() },
      },
    })
    // Process survives everything → stopGateway throws "survived SIGKILL"
    mockIsProcessAlive.mockReturnValue(true)
    // startGateway probes existing process (unhealthy) then respawns (healthy)
    mockProbeGateway
      .mockResolvedValueOnce({ healthy: false, error: 'Timeout', latencyMs: 100 })
      .mockResolvedValueOnce({ healthy: true, latencyMs: 50 })

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const promise = mod.restartGateway('sage')
    await vi.advanceTimersByTimeAsync(40)
    const result = await promise

    // startGateway should have killed the old process and spawned a new one
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    expect(mockSpawn).toHaveBeenCalled()
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.length).toBeGreaterThan(0)
    expect(result.warnings![0]).toContain('could not be stopped')

    killSpy.mockRestore()
  })
})

/* ── stopAllGateways ── */
describe('stopAllGateways', () => {
  beforeEach(() => {
    resetAllMocks()
    process.env.HERMES_TEST_KILL_SIGTERM_MS = '20'
    process.env.HERMES_TEST_KILL_SIGKILL_MS = '20'
    process.env.HERMES_TEST_POLL_INTERVAL_MS = '5'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    delete process.env.HERMES_TEST_KILL_SIGTERM_MS
    delete process.env.HERMES_TEST_KILL_SIGKILL_MS
    delete process.env.HERMES_TEST_POLL_INTERVAL_MS
    vi.useRealTimers()
  })

  it('stops all gateways in registry', async () => {
    mockReadRegistry.mockReturnValue({
      version: 1,
      entries: {
        sage: { httpPort: 8643, wsPort: 18790, pid: 11111, startedAt: Date.now() },
        jarvis: { httpPort: 8644, wsPort: 18791, pid: 22222, startedAt: Date.now() },
      },
    })
    mockGetEntry.mockImplementation(
      (registry: any, name: string) => registry.entries[name],
    )
    // Alive during stop, dead on final verification
    mockIsProcessAlive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const mod = await loadMod()
    const promise = mod.stopAllGateways()
    await vi.advanceTimersByTimeAsync(80)
    await promise

    expect(killSpy).toHaveBeenCalledWith(11111, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(22222, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(11111, 'SIGKILL')
    expect(killSpy).toHaveBeenCalledWith(22222, 'SIGKILL')
    expect(mockIsProcessAlive).toHaveBeenCalledTimes(16)
    // Serialized stops → one registry write per stop
    expect(mockWriteRegistry).toHaveBeenCalledTimes(2)

    killSpy.mockRestore()
  })

  it('handles empty registry gracefully', async () => {
    mockReadRegistry.mockReturnValue({ version: 1, entries: {} })

    const mod = await loadMod()
    await expect(mod.stopAllGateways()).resolves.not.toThrow()
  })
})

/* ── verifyWsPort ── */
describe('verifyWsPort', () => {
  it('returns true when port is reachable', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as { port: number }).port

    const mod = await loadMod()
    const result = await mod.verifyWsPort(port, 1_000)
    expect(result).toBe(true)

    server.close()
  })

  it('returns false when connection is refused', async () => {
    const mod = await loadMod()
    const result = await mod.verifyWsPort(59123, 500)
    expect(result).toBe(false)
  })
})
describe('port collision avoidance', () => {
  it('allocates sequential ports without collision when starting 3 profiles', async () => {
    resetAllMocks()
    mockExistsSync.mockReturnValue(true)
    process.env.HERMES_TEST_SPAWN_TIMEOUT_MS = '100'
    process.env.HERMES_TEST_SKIP_WS_VERIFY = '1'

    const { EventEmitter } = await import('node:events')

    const allocatedPorts: Array<{ http: number; ws: number }> = []
    mockSpawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        pid: 12345 + allocatedPorts.length,
        kill: vi.fn(),
        unref: vi.fn(),
      }) as unknown as ChildProcess
      return proc
    })
    mockProbeGateway.mockResolvedValue({ healthy: true, latencyMs: 50 })
    mockIsProcessAlive.mockImplementation(
      (pid: number) => pid >= 12345 && pid <= 12347,
    )

    const mod = await loadMod()

    for (let i = 0; i < 3; i += 1) {
      const result = await mod.startGateway(`profile-${i}`)
      allocatedPorts.push({ http: result.httpPort, ws: result.wsPort })
    }

    delete process.env.HERMES_TEST_SPAWN_TIMEOUT_MS
    delete process.env.HERMES_TEST_SKIP_WS_VERIFY

    // All HTTP ports are unique and in range
    const httpPorts = allocatedPorts.map((p) => p.http)
    expect(new Set(httpPorts).size).toBe(3)
    for (const port of httpPorts) {
      expect(port).toBeGreaterThanOrEqual(8642)
      expect(port).toBeLessThanOrEqual(8699)
    }

    // All WS ports are the same when using the hermes binary (hardcoded to 18789)
    const wsPorts = allocatedPorts.map((p) => p.ws)
    expect(new Set(wsPorts).size).toBe(1)
    for (const port of wsPorts) {
      expect(port).toBe(18789)
    }
  })
})

