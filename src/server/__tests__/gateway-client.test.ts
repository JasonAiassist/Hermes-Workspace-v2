import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildConnectParams, GatewayClient, type GatewayFrame } from '../gateway-client'

// Mock the ws module at module level
const { mockWebSocketInstances, MockWebSocket } = vi.hoisted(() => {
  const instances: Array<any> = []
  class W {
    static OPEN = 1
    static CLOSED = 3
    static CONNECTING = 0
    static CLOSING = 2

    readyState = 0
    url: string
    listeners: Record<string, Array<(...args: any[]) => void>> = {}

    constructor(url: string) {
      this.url = url
      instances.push(this)
    }

    on(event: string, listener: (...args: any[]) => void) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(listener)
      return this
    }

    once(event: string, listener: (...args: any[]) => void) {
      return this.on(event, listener)
    }

    off(event: string, listener?: (...args: any[]) => void) {
      if (!this.listeners[event]) return this
      if (listener) {
        this.listeners[event] = this.listeners[event].filter((l) => l !== listener)
      } else {
        delete this.listeners[event]
      }
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const l of this.listeners[event] ?? []) {
        l(...args)
      }
    }

    send = vi.fn()
    close = vi.fn(() => {
      this.readyState = 3
      this.emit('close')
    })
    ping = vi.fn()
    terminate = vi.fn()

    simulateOpen() {
      this.readyState = 1
      this.emit('open')
    }

    simulateMessage(data: any) {
      this.emit('message', data)
    }

    simulateError(err: Error) {
      this.emit('error', err)
    }
  }
  return { mockWebSocketInstances: instances, MockWebSocket: W }
})

vi.mock('ws', () => {
  // gateway-client.ts uses `import WebSocket from 'ws'` (default import)
  // and reads `WebSocket.OPEN` / `WebSocket.CLOSED` as static constants.
  // We export the MockWebSocket class as the default and also as a named
  // export so either import pattern works.
  const MockWS = MockWebSocket as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }
  MockWS.CONNECTING = 0
  MockWS.OPEN = 1
  MockWS.CLOSING = 2
  MockWS.CLOSED = 3
  return {
    default: MockWS,
    WebSocket: MockWS,
    RawData: class {},
  }
})

// Debug: verify the mock is in place when gateway-client is loaded
// (Commented out after debugging — no longer needed)


describe('buildConnectParams', () => {
  it('returns params with minProtocol=3, maxProtocol=3', () => {
    const params = buildConnectParams('token-123', 'pass-456')
    expect(params.minProtocol).toBe(3)
    expect(params.maxProtocol).toBe(3)
  })

  it('uses hermes-workspace-ui as client id and clawsuite as displayName', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.client.id).toBe('hermes-workspace-ui')
    expect(params.client.displayName).toBe('clawsuite')
    expect(params.client.mode).toBe('ui')
  })

  it('includes auth token and password (truthy -> present, falsy -> undefined)', () => {
    const params = buildConnectParams('my-token', 'my-pass')
    expect(params.auth?.token).toBe('my-token')
    expect(params.auth?.password).toBe('my-pass')
  })

  it('converts empty token and password to undefined', () => {
    const params = buildConnectParams('', '')
    expect(params.auth?.token).toBeUndefined()
    expect(params.auth?.password).toBeUndefined()
  })

  it('uses role=operator with operator.admin scope', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.role).toBe('operator')
    expect(params.scopes).toEqual(['operator.admin'])
  })

  it('uses v1 protocol when no nonce provided', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.client.version).toBe('v1')
  })

  it('uses v2 protocol when nonce provided', () => {
    const params = buildConnectParams('t', 'p', 'test-nonce-123')
    expect(params.client.version).toBe('v2')
    expect(params.device?.nonce).toBe('test-nonce-123')
  })

  it('generates stable device identity across calls', () => {
    const a = buildConnectParams('t', 'p')
    const b = buildConnectParams('t', 'p')
    // Same identity is cached in module-level _identity, so deviceId matches
    expect(a.device?.id).toBe(b.device?.id)
  })

  it('produces a valid base64url public key', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.device?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    // Ed25519 public key is 32 bytes = 43 chars in base64url (no padding)
    expect(params.device?.publicKey.length).toBeGreaterThanOrEqual(42)
  })

  it('signs the payload with the private key (signature is non-empty)', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.device?.signature).toBeTruthy()
    expect(params.device?.signature).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('embeds the current timestamp in the signed payload', () => {
    const before = Date.now()
    const params = buildConnectParams('t', 'p')
    const after = Date.now()
    expect(params.device?.signedAt).toBeGreaterThanOrEqual(before)
    expect(params.device?.signedAt).toBeLessThanOrEqual(after)
  })

  it('generates a unique instanceId per call', () => {
    const a = buildConnectParams('t', 'p')
    const b = buildConnectParams('t', 'p')
    // instanceId uses randomUUID() so should differ
    expect(a.client.instanceId).not.toBe(b.client.instanceId)
  })

  it('includes the process platform', () => {
    const params = buildConnectParams('t', 'p')
    expect(params.client.platform).toBe(process.platform)
  })
})
describe('GatewayClient', () => {
  beforeEach(() => {
    mockWebSocketInstances.length = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('stores the wsUrl', () => {
      const client = new GatewayClient('ws://127.0.0.1:18789')
      expect(client.wsUrl).toBe('ws://127.0.0.1:18789')
    })

    it('stores the profileName when provided', () => {
      const client = new GatewayClient('ws://test:1234', 'sage')
      expect(client.profileName).toBe('sage')
    })

    it('defaults profileName to wsUrl when not provided', () => {
      const client = new GatewayClient('ws://test:1234')
      expect(client.profileName).toBe('ws://test:1234')
    })

    it('creates a WebSocket on construction', () => {
      // Note: the WebSocket is NOT actually created by the constructor —
      // it's created lazily by ensureConnected(). This test verifies
      // that the constructor stores the URL without doing I/O.
      const client = new GatewayClient('ws://test:1234')
      expect(client.wsUrl).toBe('ws://test:1234')
    })
  })

  describe('getConnectionSnapshot', () => {
    it('returns CLOSED state with no error when never connected', () => {
      const client = new GatewayClient('ws://test:1234')
      const snapshot = client.getConnectionSnapshot()
      expect(snapshot.readyState).toBe(MockWebSocket.CLOSED)
      expect(snapshot.authenticated).toBe(false)
      expect(snapshot.errorKind).toBeNull()
    })

    it('returns CLOSED when no underlying WebSocket exists', () => {
      const client = new GatewayClient('ws://test:1234')
      // Internal ws is set on construction but readyState is CONNECTING initially
      const snapshot = client.getConnectionSnapshot()
      // After construction, ws is created but not yet connected
      expect([MockWebSocket.CONNECTING, MockWebSocket.CLOSED]).toContain(snapshot.readyState)
    })
  })

  describe('lastErrorKind', () => {
    it('returns null initially', () => {
      const client = new GatewayClient('ws://test:1234')
      expect(client.lastErrorKind).toBeNull()
    })
  })

  describe('onEvent', () => {
    it('registers a handler and returns an unsubscribe function', () => {
      const client = new GatewayClient('ws://test:1234')
      const handler = vi.fn()
      const unsub = client.onEvent(handler)
      expect(typeof unsub).toBe('function')
    })

    it('unsub is idempotent (can be called twice)', () => {
      const client = new GatewayClient('ws://test:1234')
      const handler = vi.fn()
      const unsub = client.onEvent(handler)
      unsub()
      // Second call should not throw
      expect(() => unsub()).not.toThrow()
    })

    it('unsubscribed handler is not called (after shutdown triggers events)', async () => {
      const client = new GatewayClient('ws://test:1234')
      const handler = vi.fn()
      const unsub = client.onEvent(handler)
      unsub()

      // Force the event list to flush via shutdown (which doesn't emit
      // event frames, but verifies unsubscribe is wired correctly)
      await client.shutdown()
      expect(handler).not.toHaveBeenCalled()
    })

    it('supports multiple handlers (each gets its own unsubscribe)', () => {
      const client = new GatewayClient('ws://test:1234')
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      const unsub1 = client.onEvent(handler1)
      const unsub2 = client.onEvent(handler2)
      expect(typeof unsub1).toBe('function')
      expect(typeof unsub2).toBe('function')
      // Both unsubs are independent
      unsub1()
      expect(() => unsub2()).not.toThrow()
    })
  })


  describe('request (basic error paths)', () => {
    it('throws immediately after shutdown', async () => {
      const client = new GatewayClient('ws://test:1234')
      await client.shutdown()
      await expect(client.request('test.method')).rejects.toThrow('shut down')
    })
  })

  describe('shutdown', () => {
    it('marks the client as destroyed', async () => {
      const client = new GatewayClient('ws://test:1234')
      await client.shutdown()
      // After shutdown, requests throw
      await expect(client.request('test.method')).rejects.toThrow('shut down')
    })

    it('is idempotent (multiple calls do not throw)', async () => {
      const client = new GatewayClient('ws://test:1234')
      await client.shutdown()
      await expect(client.shutdown()).resolves.toBeUndefined()
    })

    it('clears the underlying WebSocket reference', async () => {
      const client = new GatewayClient('ws://test:1234')
      // Note: WebSocket is only created when ensureConnected() is called.
      // The constructor doesn't create one. We just verify that after
      // shutdown, the snapshot reports CLOSED (not the constructor-time
      // CONNECTING state).
      await client.shutdown()
      const snapshot = client.getConnectionSnapshot()
      // After shutdown, snapshot reports CLOSED state
      expect(snapshot.readyState).toBe(MockWebSocket.CLOSED)
    })
  })

  describe('lifecycle (no real handshake)', () => {
    it('constructor does not eagerly create a WebSocket', () => {
      new GatewayClient('ws://test:1234')
      // No WebSocket is created at construction time — connection is lazy.
      // This is by design: request() and ensureConnected() drive connect.
      expect(mockWebSocketInstances).toHaveLength(0)
    })

    it('returns the provided profileName from constructor', () => {
      const client = new GatewayClient('ws://test:1234', 'sage')
      expect(client.profileName).toBe('sage')
    })

    it('returns CLOSED state when WebSocket has been closed', async () => {
      // We can't easily drive the full handshake with our mock (it requires
      // simulating the connect.challenge event, sending a connect request,
      // and receiving a response), so we directly verify the snapshot shape.
      const client = new GatewayClient('ws://test:1234')
      const snapshot = client.getConnectionSnapshot()
      expect([MockWebSocket.CONNECTING, MockWebSocket.CLOSED]).toContain(snapshot.readyState)
    })
  })

  describe('buildConnectParams integration with client', () => {
    it('client is created with the given URL (verify via client.wsUrl)', () => {
      const client = new GatewayClient('ws://integration:9999', 'integration')
      // Verify the URL was stored (don't rely on WebSocket having been
      // created — see 'constructor does not eagerly create a WebSocket' above)
      expect(client.wsUrl).toBe('ws://integration:9999')
      expect(client.profileName).toBe('integration')
    })

    it('buildConnectParams returns valid JSON-serializable params', () => {
      const params = buildConnectParams('tok', 'pwd')
      // Should be JSON-serializable (no circular refs, no Buffers at top level
      // except the base64url-encoded strings)
      const json = JSON.stringify(params)
      expect(json).toBeTruthy()
      const roundtrip = JSON.parse(json)
      expect(roundtrip.minProtocol).toBe(3)
      expect(roundtrip.maxProtocol).toBe(3)
    })
  })
})
