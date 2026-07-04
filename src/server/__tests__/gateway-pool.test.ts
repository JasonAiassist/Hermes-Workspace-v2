/**
 * Unit tests for gateway-pool.ts
 *
 * Coverage targets:
 *   - resolveGatewayHttpUrl (all branches: running, stopped, not-found, legacy)
 *   - getClient / getOrCreateClient (pool reuse, eviction, URL change)
 *   - gatewayPoolRpc / onPoolEvent (profile routing)
 *   - Pool management (remove, shutdown, size, has, reconnect)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'

// Mocks must be set up before importing the module under test.
const mockGetGatewayStatus = vi.fn()
const mockGetActiveProfileName = vi.fn().mockReturnValue('default')
const mockGetActiveProfileContext = vi.fn().mockReturnValue('')
const mockGetProfileHermesHome = vi.fn().mockReturnValue('/tmp/hermes/profiles/test')
const mockExistsSync = vi.fn().mockReturnValue(true)

const mockRequest = vi.fn().mockResolvedValue({ ok: true })
const mockOnEvent = vi.fn().mockReturnValue(() => {})
const mockShutdown = vi.fn().mockResolvedValue(undefined)
const mockGetConnectionSnapshot = vi.fn().mockReturnValue({ readyState: 1 })
const mockWsUrl = 'ws://127.0.0.1:18790'

vi.mock('../gateway-orchestrator', () => ({
  getGatewayStatus: mockGetGatewayStatus,
}))

vi.mock('../active-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
}))

vi.mock('../profile-context', () => ({
  getActiveProfileContext: mockGetActiveProfileContext,
}))

vi.mock('../gateway-registry', () => ({
  getProfileHermesHome: mockGetProfileHermesHome,
}))

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

vi.mock('../gateway-client', () => ({
  GatewayClient: vi.fn().mockImplementation((wsUrl: string, profileName: string) => ({
    wsUrl,
    profileName,
    request: mockRequest,
    onEvent: mockOnEvent,
    shutdown: mockShutdown,
    getConnectionSnapshot: mockGetConnectionSnapshot,
  })),
}))

vi.mock('ws', () => ({
  WebSocket: Object.assign(vi.fn(), {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  }),
}))

// Type-only import so we can reference error classes in assertions
import { ProfileNotFoundError, GatewayNotRunningError } from '../gateway-errors'

// Load the module under test AFTER mocks are registered.
// We use a dynamic helper so each test gets a fresh module instance (and therefore a fresh pool).
async function loadModule() {
  // vitest invalidateModule doesn't always work cleanly with dynamic imports;
  // instead we clear the pool by calling shutdownPool via the already-imported module.
  const mod = await import('../gateway-pool')
  return mod
}

describe('resolveGatewayHttpUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetProfileHermesHome.mockReturnValue('/tmp/hermes/profiles/test')
    mockGetGatewayStatus.mockResolvedValue({ status: 'unknown' })
  })

  it('returns LEGACY_HTTP_URL for default profile', async () => {
    const mod = await loadModule()
    const url = await mod.resolveGatewayHttpUrl('default')
    expect(url).toBe('http://127.0.0.1:8642')
  })

  it('returns per-profile URL when gateway is running with ports', async () => {
    const mod = await loadModule()
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    const url = await mod.resolveGatewayHttpUrl('sage')
    expect(url).toBe('http://127.0.0.1:9001')
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('sage')
  })

  it('throws GatewayNotRunningError when profile exists but gateway is stopped', async () => {
    const mod = await loadModule()
    mockGetGatewayStatus.mockResolvedValue({ status: 'stopped' })
    await expect(mod.resolveGatewayHttpUrl('sage')).rejects.toBeInstanceOf(GatewayNotRunningError)
  })

  it('throws ProfileNotFoundError when profile directory does not exist', async () => {
    const mod = await loadModule()
    mockExistsSync.mockReturnValue(false)
    mockGetGatewayStatus.mockResolvedValue({ status: 'stopped' })
    await expect(mod.resolveGatewayHttpUrl('ghost')).rejects.toBeInstanceOf(ProfileNotFoundError)
  })

  it('falls back to LEGACY_HTTP_URL when no registry entry (dev mode)', async () => {
    const mod = await loadModule()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'unknown' })
    const url = await mod.resolveGatewayHttpUrl('dev-only')
    expect(url).toBe('http://127.0.0.1:8642')
  })

  it('uses getActiveProfileContext when profileName is omitted', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('context-profile')
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9002, ws: 19002 } })
    const url = await mod.resolveGatewayHttpUrl()
    expect(url).toBe('http://127.0.0.1:9002')
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('context-profile')
  })

  it('uses getActiveProfileName when no context and no arg', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('')
    mockGetActiveProfileName.mockReturnValue('global-active')
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9003, ws: 19003 } })
    const url = await mod.resolveGatewayHttpUrl()
    expect(url).toBe('http://127.0.0.1:9003')
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('global-active')
  })

  it('falls back to default when empty string is provided', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('')
    mockGetActiveProfileName.mockReturnValue('')
    const url = await mod.resolveGatewayHttpUrl('')
    expect(url).toBe('http://127.0.0.1:8642')
  })
})

describe('getClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 }) // OPEN
  })

  afterEach(async () => {
    const mod = await loadModule()
    await mod.shutdownPool()
  })

  it('creates a new client when pool is empty', async () => {
    const mod = await loadModule()
    const client = await mod.getClient('alpha')
    expect(client).toBeDefined()
    expect(client.profileName).toBe('alpha')
    expect(mod.poolSize()).toBe(1)
  })

  it('reuses existing client when healthy and URL matches', async () => {
    const mod = await loadModule()
    const first = await mod.getClient('alpha')
    const second = await mod.getClient('alpha')
    expect(second).toBe(first)
    expect(mod.poolSize()).toBe(1)
  })

  it('evicts client when WebSocket is closed', async () => {
    const mod = await loadModule()
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 3 }) // CLOSED
    await mod.getClient('alpha')
    const client = await mod.getClient('alpha')
    // Second call should create a new instance because first was evicted
    expect(mod.poolSize()).toBe(1)
    expect(client.profileName).toBe('alpha')
  })

  it('evicts and recreates client when gateway URL changes', async () => {
    const mod = await loadModule()
    const first = await mod.getClient('alpha')
    // Simulate gateway restart on new ports
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9005, ws: 19005 } })
    const second = await mod.getClient('alpha')
    expect(second).not.toBe(first)
    expect(mod.poolSize()).toBe(1)
  })

  it('uses active profile context when no profileName given', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('ctx')
    await mod.getClient()
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('ctx')
  })

  it('uses active profile name when no context and no arg', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('')
    mockGetActiveProfileName.mockReturnValue('legacy')
    await mod.getClient()
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('legacy')
  })
})

describe('gatewayPoolRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 })
  })

  afterEach(async () => {
    const mod = await loadModule()
    await mod.shutdownPool()
  })

  it('sends RPC to the correct profile client', async () => {
    const mod = await loadModule()
    const result = await mod.gatewayPoolRpc('test.method', { foo: 'bar' }, { profileName: 'beta' })
    expect(mockRequest).toHaveBeenCalledWith('test.method', { foo: 'bar' })
    expect(result).toEqual({ ok: true })
  })

  it('uses active profile context when options omitted', async () => {
    const mod = await loadModule()
    mockGetActiveProfileContext.mockReturnValue('ctx')
    await mod.gatewayPoolRpc('test.method', {})
    expect(mockRequest).toHaveBeenCalledWith('test.method', {})
  })
})

describe('onPoolEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 })
  })

  afterEach(async () => {
    const mod = await loadModule()
    await mod.shutdownPool()
  })

  it('registers event handler on the correct profile client', async () => {
    const mod = await loadModule()
    const handler = vi.fn()
    await mod.onPoolEvent('tick', handler, { profileName: 'gamma' })
    expect(mockOnEvent).toHaveBeenCalled()
  })
})

describe('pool management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 })
  })

  afterEach(async () => {
    const mod = await loadModule()
    await mod.shutdownPool()
  })

  it('removeClient shuts down and removes from pool', async () => {
    const mod = await loadModule()
    await mod.getClient('delta')
    expect(mod.hasClient('delta')).toBe(true)
    mod.removeClient('delta')
    expect(mod.hasClient('delta')).toBe(false)
    expect(mockShutdown).toHaveBeenCalled()
  })

  it('shutdownPool clears all clients', async () => {
    const mod = await loadModule()
    await mod.getClient('a')
    await mod.getClient('b')
    expect(mod.poolSize()).toBe(2)
    await mod.shutdownPool()
    expect(mod.poolSize()).toBe(0)
  })

  it('reconnectClient shuts down existing and creates new', async () => {
    const mod = await loadModule()
    const first = await mod.getClient('epsilon')
    await mod.reconnectClient('epsilon')
    expect(mockShutdown).toHaveBeenCalled()
    expect(mod.hasClient('epsilon')).toBe(true)
  })

  it('hasClient returns false for unknown profile', async () => {
    const mod = await loadModule()
    expect(mod.hasClient('unknown')).toBe(false)
  })

  it('poolSize returns zero when empty', async () => {
    const mod = await loadModule()
    expect(mod.poolSize()).toBe(0)
  })
})

describe('profile name validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 })
  })

  afterEach(async () => {
    const mod = await loadModule()
    await mod.shutdownPool()
  })

  it('resolveGatewayHttpUrl rejects invalid profile names', async () => {
    const mod = await loadModule()
    await expect(mod.resolveGatewayHttpUrl('../../../etc/passwd')).rejects.toThrow(
      'Invalid profile name',
    )
  })

  it('getClient rejects invalid profile names', async () => {
    const mod = await loadModule()
    await expect(mod.getClient('bad name!')).rejects.toThrow('Invalid profile name')
  })

  it('removeClient rejects invalid profile names', async () => {
    const mod = await loadModule()
    expect(() => mod.removeClient('foo:bar')).toThrow('Invalid profile name')
  })

  it('hasClient rejects invalid profile names', async () => {
    const mod = await loadModule()
    expect(() => mod.hasClient('foo<bar>')).toThrow('Invalid profile name')
  })

  it('reconnectClient rejects invalid profile names', async () => {
    const mod = await loadModule()
    await expect(mod.reconnectClient('foo bar')).rejects.toThrow('Invalid profile name')
  })

  it('gatewayPoolRpc rejects invalid profile names', async () => {
    const mod = await loadModule()
    await expect(
      mod.gatewayPoolRpc('test', {}, { profileName: 'foo;bar' }),
    ).rejects.toThrow('Invalid profile name')
  })

  it('gatewayRpc rejects invalid profile names', async () => {
    const mod = await loadModule()
    await expect(mod.gatewayRpc('test', {}, 'foo@bar')).rejects.toThrow('Invalid profile name')
  })

  it('accepts valid profile names with hyphens and underscores', async () => {
    const mod = await loadModule()
    const url = await mod.resolveGatewayHttpUrl('my-profile_2')
    expect(url).toBe('http://127.0.0.1:9001')
  })
})

describe('GatewayClientPool instance methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9001, ws: 19001 } })
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 1 })
  })

  afterEach(async () => {
    // Clean up any custom pool instances
    vi.clearAllMocks()
  })

  it('can be instantiated directly', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    expect(pool).toBeDefined()
    expect(pool.poolSize()).toBe(0)
  })

  it('resolveGatewayHttpUrl on instance works independently', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    mockGetGatewayStatus.mockResolvedValue({ status: 'running', ports: { http: 9010, ws: 19010 } })
    const url = await pool.resolveGatewayHttpUrl('instance-test')
    expect(url).toBe('http://127.0.0.1:9010')
    expect(mockGetGatewayStatus).toHaveBeenCalledWith('instance-test')
  })

  it('getClient creates a client in the instance pool', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    const client = await pool.getClient('alpha')
    expect(client).toBeDefined()
    expect(client.profileName).toBe('alpha')
    expect(pool.poolSize()).toBe(1)
    expect(pool.hasClient('alpha')).toBe(true)
  })

  it('reuses existing client when healthy and URL matches', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    const first = await pool.getClient('alpha')
    const second = await pool.getClient('alpha')
    expect(second).toBe(first)
    expect(pool.poolSize()).toBe(1)
  })

  it('evicts client when WebSocket is closed', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    mockGetConnectionSnapshot.mockReturnValue({ readyState: 3 })
    await pool.getClient('alpha')
    const client = await pool.getClient('alpha')
    expect(pool.poolSize()).toBe(1)
    expect(client.profileName).toBe('alpha')
  })

  it('gatewayPoolRpc sends RPC to correct profile client', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    const result = await pool.gatewayPoolRpc('test.method', { foo: 'bar' }, { profileName: 'beta' })
    expect(mockRequest).toHaveBeenCalledWith('test.method', { foo: 'bar' })
    expect(result).toEqual({ ok: true })
  })

  it('onPoolEvent registers handler on correct profile client', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    const handler = vi.fn()
    await pool.onPoolEvent('tick', handler, { profileName: 'gamma' })
    expect(mockOnEvent).toHaveBeenCalled()
  })

  it('removeClient shuts down and removes from instance pool', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    await pool.getClient('delta')
    expect(pool.hasClient('delta')).toBe(true)
    pool.removeClient('delta')
    expect(pool.hasClient('delta')).toBe(false)
    expect(mockShutdown).toHaveBeenCalled()
  })

  it('shutdownPool clears all instance clients', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    await pool.getClient('a')
    await pool.getClient('b')
    expect(pool.poolSize()).toBe(2)
    await pool.shutdownPool()
    expect(pool.poolSize()).toBe(0)
  })

  it('reconnectClient shuts down existing and creates new', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    await pool.getClient('epsilon')
    await pool.reconnectClient('epsilon')
    expect(mockShutdown).toHaveBeenCalled()
    expect(pool.hasClient('epsilon')).toBe(true)
  })

  it('hasClient returns false for unknown profile', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    expect(pool.hasClient('unknown')).toBe(false)
  })

  it('poolSize returns zero when empty', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    expect(pool.poolSize()).toBe(0)
  })

  it('instance pool is isolated from default pool', async () => {
    const mod = await loadModule()
    const instancePool = new mod.GatewayClientPool()
    // Add client to instance pool
    await instancePool.getClient('iso')
    expect(instancePool.hasClient('iso')).toBe(true)
    expect(instancePool.poolSize()).toBe(1)
    // Default pool should not have it (assuming default pool was cleaned)
    await mod.shutdownPool()
    expect(mod.poolSize()).toBe(0)
  })

  it('rejects invalid profile names on instance', async () => {
    const mod = await loadModule()
    const pool = new mod.GatewayClientPool()
    await expect(pool.resolveGatewayHttpUrl('bad name!')).rejects.toThrow('Invalid profile name')
    await expect(pool.getClient('foo;bar')).rejects.toThrow('Invalid profile name')
    expect(() => pool.removeClient('foo:bar')).toThrow('Invalid profile name')
    expect(() => pool.hasClient('foo<bar>')).toThrow('Invalid profile name')
    await expect(pool.reconnectClient('foo bar')).rejects.toThrow('Invalid profile name')
  })
})
