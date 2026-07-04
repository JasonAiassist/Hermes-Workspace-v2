/**
 * gateway-pool.ts
 *
 * S2-T1: Per-profile gateway connection pool.
 *
 * Maintains one GatewayClient per running profile gateway.
 * Backward-compatible: gatewayRpc() without a profileName routes to the active profile.
 *
 * Architecture:
 *   GatewayClientPool (singleton)
 *     └─ profileName → GatewayClient (WS connected to :18789+)
 *                        ↓
 *                gateway-orchestrator.getGatewayStatus(name)
 *                        ↓
 *                { httpPort, wsPort } → WebSocket URL
 *
 * S2-T2: Also provides HTTP URL resolution for profile-aware REST calls.
 */

import { GatewayClient } from './gateway-client'
import { getGatewayStatus } from './gateway-orchestrator'
import { getActiveProfileName } from './active-profile'
import { GatewayNotRunningError, ProfileNotFoundError } from './gateway-errors'
import { existsSync } from 'node:fs'
import { getProfileHermesHome } from './gateway-registry'
import { getActiveProfileContext } from './profile-context'
const LEGACY_HTTP_URL = 'http://127.0.0.1:8642'

/**
 * Resolve the legacy single-gateway HTTP URL.
 *
 * Prefers explicit env overrides (HERMES_API_URL, CLAUDE_API_URL) for
 * remote/LAN/Tailscale setups, falling back to the canonical local
 * singleton at :8642.
 */
function resolveLegacyHttpUrl(): string {
  return (
    process.env.HERMES_API_URL ||
    process.env.CLAUDE_API_URL ||
    LEGACY_HTTP_URL
  )
}

const VALID_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/

function validateProfileName(name: string): void {
  if (!VALID_PROFILE_NAME.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Profile names must match /^[a-zA-Z0-9_-]+$/.`,
    )
  }
}

// ── Profile resolution helper ───────────────────────────────────────────────

function resolveProfileName(profileName?: string): string {
  return (
    profileName || getActiveProfileContext() || getActiveProfileName() || 'default'
  )
}

// ── GatewayClientPool class ─────────────────────────────────────────────────

export class GatewayClientPool {
  private pool = new Map<string, GatewayClient>()

  /**
   * Get the HTTP URL for a profile's gateway REST API.
   *
   * Behavior:
   *   - If the gateway is registered and running: returns the correct per-profile URL
   *   - If the profile directory exists but gateway is stopped: throws GatewayNotRunningError
   *   - If the profile directory doesn't exist (no registry entry): falls back to
   *     LEGACY_HTTP_URL for backward compatibility in dev/singleton mode
   */
  async resolveGatewayHttpUrl(profileName?: string): Promise<string> {
    const profile = resolveProfileName(profileName)
    validateProfileName(profile)

    const profileDir = getProfileHermesHome(profile)
    if (!existsSync(profileDir) && profile !== 'default') {
      throw new ProfileNotFoundError(profile)
    }

    const status = await getGatewayStatus(profile)

    if (status.ports) {
      return `http://127.0.0.1:${status.ports.http}`
    }

    if (status.status === 'stopped') {
      throw new GatewayNotRunningError(profile)
    }

    return resolveLegacyHttpUrl()
  }

  /**
   * Get the WebSocket URL for a profile's gateway.
   */
  private async resolveGatewayWsUrl(profileName: string): Promise<string> {
    try {
      const status = await getGatewayStatus(profileName)
      if (status.ports) {
        return `ws://127.0.0.1:${status.ports.ws}`
      }
    } catch {
      // Gateway not started via orchestrator
    }
    return 'ws://127.0.0.1:18789'
  }

  /**
   * Get or create a GatewayClient for the given profile.
   */
  private async getOrCreateClient(profileName: string): Promise<GatewayClient> {
    validateProfileName(profileName)
    const existing = this.pool.get(profileName)
    if (existing) {
      const snapshot = existing.getConnectionSnapshot()
      if (snapshot.readyState === WebSocket.CLOSED) {
        this.pool.delete(profileName)
      } else {
        const expectedWsUrl = await this.resolveGatewayWsUrl(profileName)
        if (existing.wsUrl === expectedWsUrl) {
          return existing
        }
        this.pool.delete(profileName)
        await this.shutdownWithTimeout(existing, 30000)
      }
    }

    const wsUrl = await this.resolveGatewayWsUrl(profileName)
    const client = new GatewayClient(wsUrl, profileName)
    this.pool.set(profileName, client)
    return client
  }

  /**
   * Shut down a client with a timeout to avoid blocking indefinitely.
   */
  async shutdownWithTimeout(client: GatewayClient, ms: number): Promise<void> {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(`[gateway-pool] Client shutdown timed out after ${ms}ms, proceeding`)
        resolve()
      }, ms)
    })
    await Promise.race([client.shutdown().catch(() => undefined), timeout])
  }

  /**
   * Get a GatewayClient for the given profile.
   */
  async getClient(profileName?: string): Promise<GatewayClient> {
    const name = resolveProfileName(profileName)
    return this.getOrCreateClient(name)
  }

  /**
   * RPC call to a profile's gateway WebSocket.
   */
  async gatewayPoolRpc<TPayload = unknown>(
    method: string,
    params?: unknown,
    options?: { profileName?: string },
  ): Promise<TPayload> {
    const profileName = resolveProfileName(options?.profileName)
    const client = await this.getOrCreateClient(profileName)
    return client.request<TPayload>(method, params)
  }

  /**
   * Backward-compatible alias for gatewayPoolRpc.
   * @deprecated Use gatewayPoolRpc for new code.
   */
  async gatewayRpc<TPayload = unknown>(
    method: string,
    params?: unknown,
    profileName?: string,
  ): Promise<TPayload> {
    return this.gatewayPoolRpc<TPayload>(method, params, { profileName })
  }

  /**
   * Register a global event handler on a specific profile's gateway client.
   */
  async onPoolEvent(
    event: string,
    handler: (payload: unknown) => void,
    options?: { profileName?: string },
  ): Promise<() => void> {
    const profileName = resolveProfileName(options?.profileName)
    const client = await this.getOrCreateClient(profileName)

    const fullHandler: import('./gateway-client').GatewayEventHandler = (frame) => {
      if (frame.type === 'event' || frame.type === 'evt') {
        if (frame.event === event) {
          handler(frame.payload)
        }
      }
    }

    return client.onEvent(fullHandler)
  }

  /**
   * Close and remove a profile's client from the pool.
   */
  removeClient(profileName: string): void {
    validateProfileName(profileName)
    const client = this.pool.get(profileName)
    if (client) {
      client.shutdown().catch(() => {
        // ignore shutdown errors
      })
      this.pool.delete(profileName)
    }
  }

  /**
   * Shutdown all clients in the pool.
   */
  async shutdownPool(): Promise<void> {
    const clients = Array.from(this.pool.values())
    this.pool.clear()
    await Promise.all(clients.map((c) => c.shutdown().catch(() => undefined)))
  }

  /**
   * Return the number of active connections in the pool.
   */
  poolSize(): number {
    return this.pool.size
  }

  /**
   * Check whether a client exists for the given profile.
   */
  hasClient(profileName: string): boolean {
    validateProfileName(profileName)
    return this.pool.has(profileName)
  }

  /**
   * Force-reconnect a profile's client (useful after gateway port change).
   */
  async reconnectClient(profileName: string): Promise<void> {
    validateProfileName(profileName)
    const existing = this.pool.get(profileName)
    if (existing) {
      await existing.shutdown()
      this.pool.delete(profileName)
    }
    await this.getOrCreateClient(profileName)
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

const defaultPool = new GatewayClientPool()

// ── Convenience exports (backward-compatible) ─────────────────────────────────

export async function resolveGatewayHttpUrl(profileName?: string): Promise<string> {
  return defaultPool.resolveGatewayHttpUrl(profileName)
}

export async function getClient(profileName?: string): Promise<GatewayClient> {
  return defaultPool.getClient(profileName)
}

export type GatewayPoolRpcOptions = {
  profileName?: string
}

export async function gatewayPoolRpc<TPayload = unknown>(
  method: string,
  params?: unknown,
  options?: GatewayPoolRpcOptions,
): Promise<TPayload> {
  return defaultPool.gatewayPoolRpc(method, params, options)
}

export async function gatewayRpc<TPayload = unknown>(
  method: string,
  params?: unknown,
  profileName?: string,
): Promise<TPayload> {
  return defaultPool.gatewayRpc(method, params, profileName)
}

export async function onPoolEvent(
  event: string,
  handler: (payload: unknown) => void,
  options?: GatewayPoolRpcOptions,
): Promise<() => void> {
  return defaultPool.onPoolEvent(event, handler, options)
}

export function removeClient(profileName: string): void {
  return defaultPool.removeClient(profileName)
}

export async function shutdownPool(): Promise<void> {
  return defaultPool.shutdownPool()
}

export function poolSize(): number {
  return defaultPool.poolSize()
}

export function hasClient(profileName: string): boolean {
  return defaultPool.hasClient(profileName)
}

export async function reconnectClient(profileName: string): Promise<void> {
  return defaultPool.reconnectClient(profileName)
}

export async function shutdownWithTimeout(client: GatewayClient, ms: number): Promise<void> {
  return defaultPool.shutdownWithTimeout(client, ms)
}
