/**
 * Gateway health monitor — background loop that checks all running gateways
 * and auto-restarts unhealthy ones with exponential backoff.
 *
 * Backoff: 5s → 30s → 120s between restart attempts.
 * Max 3 restarts per 10-minute window per gateway.
 * After 3 failures: gateway marked "failed", manual start required.
 */

import { probeGateway, type ProbeResult } from './gateway-health'
import {
  readGatewayRegistry,
  isProcessAlive,
  type GatewayRegistryEntry,
} from './gateway-registry'
import {
  startGateway,
  stopGateway,
  type GatewayStatus,
} from './gateway-orchestrator'
import {
  getRecord,
  resetRecord,
  getAllMonitorStates,
  getMonitorState,
  resetMonitorState,
  deleteMonitorState,
  type GatewayMonitorState,
  type RestartRecord,
} from './gateway-monitor-state'

/* — tunables (env-overridable for tests) — */
const CHECK_INTERVAL_MS =
  Number(process.env.HERMES_MONITOR_INTERVAL_MS) || 30_000
const MAX_RESTARTS_PER_WINDOW = 3
const RESTART_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const BACKOFF_DELAYS_MS = [5_000, 30_000, 120_000]

/* — restart tracking — */
const restartingGateways = new Set<string>()

let monitorInterval: ReturnType<typeof setInterval> | null = null
let isRunning = false

/* — helpers — */

function getNow(): number {
  return Date.now()
}

function isWithinWindow(record: RestartRecord): boolean {
  return getNow() - record.lastAttemptAt < RESTART_WINDOW_MS
}

function nextBackoffDelay(record: RestartRecord): number {
  const idx = Math.min(record.attempts, BACKOFF_DELAYS_MS.length - 1)
  return BACKOFF_DELAYS_MS[idx]
}

function shouldAttemptRestart(record: RestartRecord): boolean {
  if (record.state === 'failed') return false
  if (record.attempts >= MAX_RESTARTS_PER_WINDOW && isWithinWindow(record)) {
    return false
  }
  // If window expired, allow a fresh cycle
  if (!isWithinWindow(record)) {
    record.attempts = 0
  }
  return true
}

/* — health check — */

async function checkGateway(
  profileName: string,
  entry: GatewayRegistryEntry,
): Promise<GatewayStatus & { lastProbe?: ProbeResult }> {
  const probe = await probeGateway(entry.httpPort)
  const record = getRecord(profileName)
  record.lastProbe = probe

  if (probe.healthy) {
    if (record.state !== 'healthy') {
      resetRecord(profileName)
    }
    return {
      status: 'healthy',
      pid: entry.pid,
      ports: { http: entry.httpPort, ws: entry.wsPort },
      health: { latencyMs: probe.latencyMs },
      lastProbe: probe,
    }
  }

  return {
    status: 'unhealthy',
    pid: entry.pid,
    ports: { http: entry.httpPort, ws: entry.wsPort },
    health: {
      latencyMs: (probe as Extract<typeof probe, { healthy: false }>).latencyMs ?? 0,
      error: (probe as Extract<typeof probe, { healthy: false }>).error,
    },
    lastProbe: probe,
  }
}

/* — restart — */

async function tryRestartGateway(profileName: string): Promise<void> {
  if (restartingGateways.has(profileName)) return
  restartingGateways.add(profileName)

  try {
    const record = getRecord(profileName)

    if (!shouldAttemptRestart(record)) {
      if (record.state !== 'failed') {
        record.state = 'failed'
        console.warn(
          JSON.stringify({
            event: 'gateway-monitor.max-restarts-exceeded',
            profile: profileName,
            attempts: record.attempts,
            timestamp: new Date().toISOString(),
          }),
        )
      }
      return
    }

    record.state = 'restarting'
    const delay = nextBackoffDelay(record)
    record.attempts += 1
    record.lastAttemptAt = getNow()

    console.warn(
      JSON.stringify({
        event: 'gateway-monitor.restart-attempt',
        profile: profileName,
        attempt: record.attempts,
        backoffMs: delay,
        timestamp: new Date().toISOString(),
      }),
    )

    // Stop current gateway if still running
    try {
      await stopGateway(profileName)
    } catch {
      /* ignore stop errors */
    }

    // Apply backoff delay before attempting start
    await new Promise((r) => setTimeout(r, delay))
    if (!isRunning) return   // bail out if monitoring stopped during backoff

    try {
      await startGateway(profileName)
      resetRecord(profileName)
      console.warn(
        JSON.stringify({
          event: 'gateway-monitor.restart-success',
          profile: profileName,
          timestamp: new Date().toISOString(),
        }),
      )
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      // Do NOT set state to 'failed' here — that happens only when max restarts
      // are exceeded inside shouldAttemptRestart. Leave state as 'restarting'
      // so the next monitor cycle can attempt again if attempts allow.
      console.warn(
        JSON.stringify({
          event: 'gateway-monitor.restart-failure',
          profile: profileName,
          error: errMsg,
          timestamp: new Date().toISOString(),
        }),
      )
    }
  } finally {
    restartingGateways.delete(profileName)
  }
}

/* — monitor loop — */

async function runMonitorCycle(): Promise<void> {
  const registry = readGatewayRegistry()

  for (const [profileName, entry] of Object.entries(registry.entries)) {
    try {
      // Externally-managed gateways (systemd) — health-check only, never respawn
      if (entry.pid === -1) {
        const status = await checkGateway(profileName, entry)
        if (status.status === 'unhealthy') {
          // Record failure but do not attempt restart — systemd owns the lifecycle
          console.warn(
            JSON.stringify({
              event: 'gateway-monitor.unhealthy-externally-managed',
              profile: profileName,
              error: status.health?.error,
              timestamp: new Date().toISOString(),
            }),
          )
        }
        continue
      }

      if (!isProcessAlive(entry.pid)) {
        // Process died externally — attempt restart
        await tryRestartGateway(profileName)
        continue
      }

      const status = await checkGateway(profileName, entry)
      if (status.status === 'unhealthy') {
        await tryRestartGateway(profileName)
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'gateway-monitor.cycle-error',
          profile: profileName,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      )
    }
  }
}

/* — public API — */

export function startMonitoring(): void {
  if (isRunning) return
  isRunning = true

  // Run first check immediately, then on interval
  void runMonitorCycle().catch(() => {
    // ignore — individual gateway errors are logged
  })

  monitorInterval = setInterval(() => {
    void runMonitorCycle().catch(() => {
      // ignore
    })
  }, CHECK_INTERVAL_MS)
}

export function stopMonitoring(): void {
  if (!isRunning) return
  isRunning = false
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
  // Do NOT clear restartState here — persisting failure history across
  // stop/start cycles prevents max-restart bypass after a brief hiccup.
  restartingGateways.clear()
}

export function isMonitoring(): boolean {
  return isRunning
}
