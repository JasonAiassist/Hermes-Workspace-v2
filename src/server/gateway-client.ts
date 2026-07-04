/**
 * gateway-client.ts
 *
 * Extracted from gateway.ts (Sprint 2, S2-T1).
 * One GatewayClient instance per profile gateway WebSocket connection.
 * Supports connecting to any host:port (not just the singleton localhost:18789).
 */

import { randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as cryptoSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { classifyConnectionError } from '../lib/connection-errors'

// ── Frame types (shared with gateway.ts) ──────────────────────────────────────

export type GatewayFrame =
  | { type: 'req'; id: string; method: string; params?: unknown }
  | {
      type: 'res'
      id: string
      ok: boolean
      payload?: unknown
      error?: { code: string; message: string; details?: unknown }
    }
  | { type: 'event'; event: string; payload?: unknown; seq?: number }
  | {
      type: 'evt'
      event: string
      payload?: unknown
      payloadJSON?: string
      seq?: number
    }

type ConnectParams = {
  minProtocol: number
  maxProtocol: number
  client: {
    id: string
    displayName?: string
    version: string
    platform: string
    mode: string
    instanceId?: string
  }
  auth?: { token?: string; password?: string }
  role?: 'operator' | 'node'
  scopes?: Array<string>
  device?: { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string }
}

type PendingRequest = {
  id: string
  method: string
  params?: unknown
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

type InflightRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

// ── Device identity (Ed25519) ─────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derivePublicKeyRaw(pem: string): Buffer {
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' })
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  )
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  return spki
}

type DeviceIdentity = {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
}

let _identity: DeviceIdentity | null = null

function getDeviceIdentity(): DeviceIdentity {
  if (_identity) return _identity
  try {
    if (typeof window === 'undefined') {
      // eslint-disable-next-line no-process-env
      const resolved = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'identity', 'hermes-device.json')
      if (existsSync(resolved)) {
        const p = JSON.parse(readFileSync(resolved, 'utf8'))
        if (p?.version === 1 && p.deviceId && p.publicKeyPem && p.privateKeyPem) {
          _identity = { deviceId: p.deviceId, publicKeyPem: p.publicKeyPem, privateKeyPem: p.privateKeyPem }
          return _identity
        }
      }
    }
  } catch { /* regenerate */ }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const deviceId = createHash('sha256').update(derivePublicKeyRaw(pubPem)).digest('hex')
  _identity = { deviceId, publicKeyPem: pubPem, privateKeyPem: privPem }
  return _identity
}

function signPayload(privPem: string, payload: string): string {
  return base64UrlEncode(
    cryptoSign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privPem)) as unknown as Buffer,
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_DELAYS_MS = [1000, 2000, 4000]
const MAX_RECONNECT_DELAY_MS = 30000
const HEARTBEAT_INTERVAL_MS = 30000
const HEARTBEAT_TIMEOUT_MS = 20000
const HANDSHAKE_TIMEOUT_MS = 15000
const RPC_TIMEOUT_MS = () =>
  Number(process.env.HERMES_TEST_RPC_TIMEOUT_MS) || 30000

// Circuit breaker: prevent request floods when gateway is unreachable
const CIRCUIT_BREAKER_THRESHOLD = 15
const CIRCUIT_BREAKER_COOLDOWN_MS = 10000

// Defensive queue cap: reject rather than exhaust memory under sustained failure
const MAX_REQUEST_QUEUE_SIZE = 100
const MAX_INFLIGHT_SIZE = 50

// ── Config helpers ─────────────────────────────────────────────────────────────

export type GatewayConfig = {
  url: string
  token: string
  password: string
}

export function buildConnectParams(
  token: string,
  password: string,
  nonce?: string,
): ConnectParams {
  const identity = getDeviceIdentity()
  const role = 'operator'
  const scopes = ['operator.admin']
  const signedAtMs = Date.now()
  const clientId = 'hermes-workspace-ui'
  const clientMode = 'ui'
  const version = nonce ? 'v2' : 'v1'
  const parts = [
    version,
    identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token || '',
  ]
  if (version === 'v2') parts.push(nonce || '')
  const signature = signPayload(identity.privateKeyPem, parts.join('|'))

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      displayName: 'clawsuite',
      version,
      platform: process.platform,
      mode: clientMode,
      instanceId: randomUUID(),
    },
    auth: {
      token: token || undefined,
      password: password || undefined,
    },
    role,
    scopes,
    device: {
      id: identity.deviceId,
      publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
      signature,
      signedAt: signedAtMs,
      nonce,
    },
  }
}

// ── GatewayClient ─────────────────────────────────────────────────────────────

export type GatewayEventHandler = (frame: GatewayFrame) => void

export class GatewayClient {
  private ws: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private heartbeatTimeout: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private authenticated = false
  private destroyed = false
  private _lastErrorKind: import('../lib/connection-errors').ConnectionErrorKind | null = null

  // Circuit breaker
  private circuitFailures = 0
  private circuitOpen = false
  private circuitOpenedAt = 0

  private requestQueue: Array<PendingRequest> = []
  private inflight = new Map<string, InflightRequest>()
  private eventListeners = new Set<GatewayEventHandler>()

  /** Profile name this client is connected to (for debugging/ pool indexing). */
  public readonly profileName: string

  constructor(public readonly wsUrl: string, profileName?: string) {
    this.profileName = profileName ?? wsUrl
  }

  get lastErrorKind() {
    return this._lastErrorKind
  }

  onEvent(handler: GatewayEventHandler): () => void {
    this.eventListeners.add(handler)
    return () => {
      this.eventListeners.delete(handler)
    }
  }

  getConnectionSnapshot(): {
    readyState: number
    authenticated: boolean
    errorKind: import('../lib/connection-errors').ConnectionErrorKind | null
  } {
    return {
      readyState: this.ws?.readyState ?? WebSocket.CLOSED,
      authenticated: this.authenticated,
      errorKind: this._lastErrorKind,
    }
  }

  async request<TPayload = unknown>(method: string, params?: unknown): Promise<TPayload> {
    if (this.destroyed) {
      throw new Error('Gateway client is shut down')
    }

    // Circuit breaker: fast-fail when gateway is known-unreachable
    if (this.circuitOpen) {
      if (Date.now() - this.circuitOpenedAt < CIRCUIT_BREAKER_COOLDOWN_MS) {
        throw new Error(
          `Gateway circuit breaker open (${this.circuitFailures} consecutive failures, cooling down)`,
        )
      }
      this.circuitOpen = false
    }

    const requestId = randomUUID()
    let settled = false

    const rpcCall = new Promise<TPayload>((resolve, reject) => {
      const request: PendingRequest = {
        id: requestId,
        method,
        params,
        resolve: (value: unknown) => {
          if (settled) return
          settled = true
          this.circuitFailures = 0
          this.circuitOpen = false
          resolve(value as TPayload)
        },
        reject: (reason?: unknown) => {
          if (settled) return
          settled = true
          reject(reason)
        },
      }

      this.requestQueue.push(request)
      if (this.requestQueue.length > MAX_REQUEST_QUEUE_SIZE) {
        // Evict oldest pending request to make room
        const dropped = this.requestQueue.shift()
        dropped?.reject(new Error('Gateway request queue is full'))
      }
      this.ensureConnected().catch(() => {
        // keep requests queued; reconnect loop will flush after reconnect
      })
      this.flushQueue()
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (settled) return
        settled = true
        this.cleanupPendingRequest(requestId)
        const slowRpcs = ['sessions.usage', 'sessions.costs', 'usage.analytics', 'usage.summary']
        if (!slowRpcs.includes(method)) {
          this.circuitFailures += 1
        }
        if (this.circuitFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.circuitOpen = true
          this.circuitOpenedAt = Date.now()
          console.warn(
            `[gateway-client] Circuit breaker OPEN after ${this.circuitFailures} consecutive timeouts (last: ${method})`,
          )
        } else {
          console.warn(
            `[gateway-client] RPC timeout after ${RPC_TIMEOUT_MS()}ms for ${method} (${this.circuitFailures}/${CIRCUIT_BREAKER_THRESHOLD})`,
          )
        }
        reject(new Error('Gateway RPC timeout'))
      }, RPC_TIMEOUT_MS())
    })

    // Prevent unhandled rejection when the losing Promise settles after the race
    rpcCall.catch(() => {})
    timeoutPromise.catch(() => {})

    return Promise.race([rpcCall, timeoutPromise])
  }

  async ensureConnected(): Promise<void> {
    if (this.destroyed) {
      throw new Error('Gateway client is shut down')
    }
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = this.openAndHandshake()
      .then(() => {
        this.reconnectAttempts = 0
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error))
        // Clear connectPromise BEFORE scheduleReconnect so the reconnect
        // loop isn't aborted by the truthy check in scheduleReconnect().
        this.connectPromise = null
        this.scheduleReconnect()
        throw err
      })
      .finally(() => {
        this.connectPromise = null
      })

    return this.connectPromise
  }

  async shutdown(): Promise<void> {
    this.destroyed = true
    this.clearReconnectTimer()
    this.stopHeartbeat()

    const ws = this.ws
    this.ws = null
    this.authenticated = false

    const closePromise = ws ? this.closeSocket(ws) : Promise.resolve()

    this.rejectQueuedRequests(new Error('Gateway client is shut down'))
    this.rejectInflightRequests(new Error('Gateway client is shut down'))

    await closePromise.catch(() => {
      // ignore
    })
  }

  private async openAndHandshake(): Promise<void> {
    let lastError: Error | null = null
    const maxRetries = 2

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
        }

        // Parse URL to derive origin
        let gatewayOrigin = 'http://127.0.0.1:18789'
        try {
          const parsed = new URL(this.wsUrl.replace(/^ws/, 'http'))
          gatewayOrigin = `${parsed.protocol}//${parsed.host}`
        } catch { /* use default */ }

        const ws = new WebSocket(this.wsUrl, {
          origin: gatewayOrigin,
          headers: { Origin: gatewayOrigin },
        })

        this.clearReconnectTimer()

        await this.waitForOpen(ws, HANDSHAKE_TIMEOUT_MS)

        if (this.destroyed) {
          ws.terminate()
          throw new Error('Gateway client is shut down')
        }

        this.ws = ws
        this.authenticated = false

        // Temporary close/error handlers for the handshake phase.
        // Permanent listeners are only registered after the challenge succeeds
        // to avoid orphaned or duplicated listeners.
        const onHandshakeClose = () => { /* ignored — handled by timeout/catch */ }
        const onHandshakeError = (_err: Error) => { /* ignored — handled by timeout/catch */ }
        ws.once('close', onHandshakeClose)
        ws.once('error', onHandshakeError)

        // Wait for connect.challenge to get nonce
        let challengeNonce: string | undefined
        let challengeResolved = false
        const nonce = await new Promise<string | undefined>((resolve) => {
          const handler = (data: RawData) => {
            try {
              const f = JSON.parse(rawDataToString(data))
              if ((f.type === 'event' || f.type === 'evt') && f.event === 'connect.challenge') {
                challengeNonce = f.payload?.nonce || undefined
                if (!challengeResolved) {
                  challengeResolved = true
                  resolve(challengeNonce)
                }
                return
              }
            } catch { /* ignore */ }
            this.handleMessage(data)
          }
          ws.removeAllListeners('message')
          ws.on('message', handler)
          setTimeout(() => {
            if (!challengeResolved) {
              challengeResolved = true
              resolve(undefined)
            }
          }, 3000)
        })

        // Re-attach normal message handler
        ws.removeAllListeners('message')
        ws.on('message', (data: RawData) => {
          this.handleMessage(data)
        })

        const connectId = randomUUID()
        const connectReq: GatewayFrame = {
          type: 'req',
          id: connectId,
          method: 'connect',
          params: buildConnectParams('', '', nonce),
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.inflight.delete(connectId)
            reject(new Error('Gateway handshake timed out'))
          }, HANDSHAKE_TIMEOUT_MS)

          this.inflight.set(connectId, {
            resolve: () => {
              clearTimeout(timeout)
              resolve()
            },
            reject: (err) => {
              clearTimeout(timeout)
              reject(err)
            },
          })

          this.sendFrame(connectReq).catch((error: unknown) => {
            this.inflight.delete(connectId)
            clearTimeout(timeout)
            reject(error)
          })
        })

        // Remove temporary handshake listeners and attach permanent ones
        ws.off('close', onHandshakeClose)
        ws.off('error', onHandshakeError)
        this.attachPermanentListeners(ws)

        this.authenticated = true
        this.startHeartbeat()
        this.flushQueue()
        this._lastErrorKind = null
        this.circuitFailures = 0
        this.circuitOpen = false
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        try {
          this._lastErrorKind = classifyConnectionError(lastError)
        } catch { /* module may not be available */ }
        if (this.ws) {
          this.ws.terminate()
          this.ws = null
        }
        if (this.destroyed) break
      }
    }

    throw lastError || new Error('Failed to connect to gateway after retries')
  }

  private attachPermanentListeners(ws: WebSocket) {
    ws.on('pong', () => {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout)
        this.heartbeatTimeout = null
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonText = reason?.toString() || 'n/a'
      this.handleDisconnect(
        new Error(`Gateway connection closed (code=${code}, reason=${reasonText})`),
      )
    })

    ws.on('error', (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error))
      this.handleDisconnect(err)
    })
  }

  private handleMessage(data: RawData) {
    let frame: GatewayFrame
    try {
      frame = JSON.parse(rawDataToString(data)) as GatewayFrame
    } catch {
      return
    }

    if (frame.type === 'event' || frame.type === 'evt') {
      for (const listener of Array.from(this.eventListeners)) {
        try {
          listener(frame)
        } catch {
          // ignore listener errors
        }
      }
      return
    }

    if (frame.type !== 'res') return

    const pending = this.inflight.get(frame.id)
    if (!pending) return

    this.inflight.delete(frame.id)

    if (frame.ok) {
      pending.resolve(frame.payload)
    } else {
      pending.reject(new Error(frame.error?.message ?? 'gateway error'))
    }
  }

  private handleDisconnect(error: Error) {
    const ws = this.ws
    this.ws = null
    this.authenticated = false
    this.stopHeartbeat()

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.terminate()
      } catch {
        // ignore
      }
    }

    this.rejectInflightRequests(error)

    if (this.destroyed) {
      this.rejectQueuedRequests(error)
      return
    }

    this.scheduleReconnect()
  }

  private flushQueue() {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    while (this.requestQueue.length > 0) {
      if (this.inflight.size >= MAX_INFLIGHT_SIZE) break
      const pending = this.requestQueue.shift()
      if (!pending) continue

      const frame: GatewayFrame = {
        type: 'req',
        id: pending.id,
        method: pending.method,
        params: pending.params,
      }

      this.inflight.set(pending.id, {
        resolve: pending.resolve,
        reject: pending.reject,
      })

      this.sendFrame(frame).catch((error: unknown) => {
        this.inflight.delete(pending.id)
        pending.reject(error)
      })
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer || this.connectPromise) {
      return
    }

    const delay = nextReconnectDelayMs(this.reconnectAttempts)
    this.reconnectAttempts += 1

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ensureConnected()
        .then(() => {
          this.flushQueue()
        })
        .catch(() => {
          // next reconnect is scheduled by ensureConnected/openAndHandshake
        })
    }, delay)
  }

  private startHeartbeat() {
    this.stopHeartbeat()

    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return
      }

      try {
        this.ws.ping()
      } catch {
        this.handleDisconnect(new Error('Gateway ping failed'))
        return
      }

      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout)
      }

      this.heartbeatTimeout = setTimeout(() => {
        this.heartbeatTimeout = null
        this.handleDisconnect(new Error('Gateway ping timeout'))
      }, HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  private async sendFrame(frame: GatewayFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway connection not open')
    }

    await new Promise<void>((resolve, reject) => {
      this.ws?.send(JSON.stringify(frame), (err: Error | undefined) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  private waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('WebSocket connection timed out'))
      }, timeoutMs)

      function onOpen() {
        cleanup()
        resolve()
      }

      function onError(error: Error) {
        cleanup()
        reject(new Error(`WebSocket error: ${String(error.message)}`))
      }

      function cleanup() {
        clearTimeout(timeout)
        ws.off('open', onOpen)
        ws.off('error', onError)
      }

      ws.on('open', onOpen)
      ws.on('error', onError)
    })
  }

  private closeSocket(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    })
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private rejectQueuedRequests(error: Error) {
    for (const pending of this.requestQueue) {
      pending.reject(error)
    }
    this.requestQueue = []
  }

  private rejectInflightRequests(error: Error) {
    for (const pending of Array.from(this.inflight.values())) {
      pending.reject(error)
    }
    this.inflight.clear()
  }

  private cleanupPendingRequest(requestId: string): boolean {
    const queueIndex = this.requestQueue.findIndex((pending) => pending.id === requestId)
    if (queueIndex >= 0) {
      this.requestQueue.splice(queueIndex, 1)
      return true
    }

    if (this.inflight.has(requestId)) {
      this.inflight.delete(requestId)
      return true
    }

    return false
  }
}

function nextReconnectDelayMs(attempt: number): number {
  if (attempt < RECONNECT_DELAYS_MS.length) {
    return RECONNECT_DELAYS_MS[attempt]
  }

  const doubled = RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] * 2 ** (attempt - 2)
  return Math.min(doubled, MAX_RECONNECT_DELAY_MS)
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString()
}
