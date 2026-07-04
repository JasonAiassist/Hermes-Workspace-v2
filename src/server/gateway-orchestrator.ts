/**
 * Gateway orchestrator — spawn, stop, and monitor per-profile gateway processes.
 *
 * Port allocation is constrained to the Epic-specified ranges:
 *   HTTP:  8642–8699
 *   WS:    18789–18899
 *
 * The registry is only cleaned up *after* a process is confirmed dead,
 * preventing zombie processes with no tracking entry.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { probeGateway } from './gateway-health'
import {
  ProfileNotFoundError,
  GatewayStartError,
  GatewayStopError,
} from './gateway-errors'
import {
  type GatewayRegistry,
  type GatewayRegistryEntry,
  readGatewayRegistry,
  writeGatewayRegistry,
  getRegistryEntry,
  setRegistryEntry,
  removeRegistryEntry,
  isProcessAlive,
  initializeGatewayRegistry,
  getProfileHermesHome,
} from './gateway-registry'
import {
  resolveHermesBinary,
  resolveHermesAgentDir,
  resolveHermesPython,
  buildHermesPath,
} from './hermes-agent'
import { removeClient } from './gateway-pool'
import { resetMonitorState } from './gateway-monitor-state'
import { getProfileWorkspaceConfig } from './profile-workspace-config'

/**
 * Read a profile's .env file and return key=value pairs as an object.
 */
function readProfileEnv(profileName: string): Record<string, string> {
  const envPath = join(getProfileHermesHome(profileName), '.env')
  if (!existsSync(envPath)) return {}
  try {
    const content = readFileSync(envPath, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1).trim()
      result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/* ── timeouts (env-overridable for tests) ── */
const SPAWN_TIMEOUT_MS =
  Number(process.env.HERMES_TEST_SPAWN_TIMEOUT_MS) || 5_000
const KILL_SIGTERM_MS =
  Number(process.env.HERMES_TEST_KILL_SIGTERM_MS) || 5_000
const KILL_SIGKILL_MS =
  Number(process.env.HERMES_TEST_KILL_SIGKILL_MS) || 3_000
const POLL_INTERVAL_MS =
  Number(process.env.HERMES_TEST_POLL_INTERVAL_MS) || 500

/* ── port ranges per Epic spec ── */
const HTTP_PORT_MIN = 8642
const HTTP_PORT_MAX = 8699
const WS_PORT_MIN = 18789
const WS_PORT_MAX = 18899

/* ── spawn retry for TOCTOU race mitigation ── */
const SPAWN_RETRIES = 3

/* ── port allocation mutex ── */
let _portLock: Promise<void> = Promise.resolve()

async function acquirePortLock(): Promise<() => void> {
  let release: () => void
  const promise = new Promise<void>((res) => {
    release = res
  })
  const previous = _portLock
  _portLock = previous.then(() => promise)
  await previous
  return release!
}

/* ── concurrency guards ── */
const startingProfiles = new Set<string>()
const stoppingProfiles = new Set<string>()

/* ── helpers ── */

function assertProfileExists(profileName: string): void {
  const home = getProfileHermesHome(profileName)
  if (!existsSync(home)) {
    throw new ProfileNotFoundError(profileName)
  }
}

/**
 * Check whether a TCP port is free by attempting to bind a server.
 * Returns true if the port is available, false if EADDRINUSE.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false)
      } else {
        // Treat other errors as available (permissions, etc. are rare in our ranges)
        resolve(true)
      }
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Find the first candidate port in a given inclusive range.
 * Returns null if every port in the range is excluded or in use.
 *
 * We bind-test each candidate to skip ports already held by external
 * processes (e.g. systemd-managed gateways) that are not in our registry.
 * The port lock acquired in trySpawnGateway serialises allocations,
 * minimising the check-then-use race.
 */
async function allocatePortInRange(
  min: number,
  max: number,
  exclude?: Set<number>,
): Promise<number | null> {
  for (let port = min; port <= max; port += 1) {
    if (exclude?.has(port)) continue
    if (await isPortFree(port)) return port
  }
  return null
}

/**
 * Allocate an HTTP port and a WS port from the Epic-specified ranges.
 * Skips ports that are already assigned to other registered gateways
 * or held by external processes.
 */
async function allocateGatewayPorts(): Promise<{
  httpPort: number
  wsPort: number
}> {
  const registry = readGatewayRegistry()
  const usedHttpPorts = new Set(
    Object.values(registry.entries)
      .filter((e) => isProcessAlive(e.pid))
      .map((e) => e.httpPort),
  )
  const usedWsPorts = new Set(
    Object.values(registry.entries)
      .filter((e) => isProcessAlive(e.pid))
      .map((e) => e.wsPort),
  )

  const httpPort = await allocatePortInRange(
    HTTP_PORT_MIN,
    HTTP_PORT_MAX,
    usedHttpPorts,
  )
  if (httpPort === null) {
    throw new Error(
      `No free HTTP ports in range ${HTTP_PORT_MIN}–${HTTP_PORT_MAX}`,
    )
  }

  const wsPort = await allocatePortInRange(
    WS_PORT_MIN,
    WS_PORT_MAX,
    usedWsPorts,
  )
  if (wsPort === null) {
    throw new Error(
      `No free WS ports in range ${WS_PORT_MIN}–${WS_PORT_MAX}`,
    )
  }

  return { httpPort, wsPort }
}

/**
 * Wait for a process to exit, polling with isProcessAlive.
 */
async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

/* ── public API ── */

export type StartResult = {
  httpPort: number
  wsPort: number
  pid: number
  warnings?: string[]
}

export type GatewayStatus = {
  status: 'stopped' | 'healthy' | 'unhealthy'
  pid?: number
  ports?: { http: number; ws: number }
  health?: { latencyMs: number; error?: string }
}

/**
 * Start (or reuse) a gateway for the given profile.
 *
 * If a gateway is already registered and its process is alive, returns
 * the existing allocation without spawning.
 *
 * Validates the profile directory exists only when a new spawn is required.
 *
 * Retries on port-allocation races (TOCTOU) up to SPAWN_RETRIES times.
 */
export async function startGateway(
  profileName: string,
): Promise<StartResult> {
  if (startingProfiles.has(profileName)) {
    throw new GatewayStartError(
      `Gateway start already in progress for profile "${profileName}"`,
    )
  }
  startingProfiles.add(profileName)

  try {
    const registry = readGatewayRegistry()
    const existing = getRegistryEntry(registry, profileName)

    if (existing && isProcessAlive(existing.pid)) {
      const probe = await probeGateway(existing.httpPort, SPAWN_TIMEOUT_MS)
      if (probe.healthy) {
        return {
          httpPort: existing.httpPort,
          wsPort: existing.wsPort,
          pid: existing.pid,
        }
      }
      // Process is alive but unhealthy — kill it and respawn
      removeClient(profileName)
      try {
        process.kill(existing.pid, 'SIGTERM')
      } catch {
        // ignore
      }
      removeRegistryEntry(registry, profileName)
      writeGatewayRegistry(registry)
    }

    // Handle externally-managed entries (pid: -1) — just verify health and reuse
    if (existing && existing.pid === -1) {
      const probe = await probeGateway(existing.httpPort, SPAWN_TIMEOUT_MS)
      if (probe.healthy) {
        return {
          httpPort: existing.httpPort,
          wsPort: existing.wsPort,
          pid: -1,
        }
      }
      // Gateway no longer responding — clean up stale entry and fall through to spawn
      removeClient(profileName)
      removeRegistryEntry(registry, profileName)
      writeGatewayRegistry(registry)
    }

    // For the default profile, adopt an existing singleton gateway on the
    // default port if one is already running but not in our registry.
    if (profileName === 'default' && !existing) {
      const singletonProbe = await probeGateway(HTTP_PORT_MIN, SPAWN_TIMEOUT_MS)
      if (singletonProbe.healthy) {
        const entry: GatewayRegistryEntry = {
          httpPort: HTTP_PORT_MIN,
          wsPort: 18789,
          pid: -1, // unknown — we don't know the owner PID
          startedAt: Date.now(),
        }
        setRegistryEntry(registry, 'default', entry)
        writeGatewayRegistry(registry)
        return {
          httpPort: HTTP_PORT_MIN,
          wsPort: 18789,
          pid: -1,
        }
      }
    }

    // For non-default profiles, adopt an externally-running gateway if one
    // exists (e.g. started via systemd or hermes CLI).
    if (profileName !== 'default' && !existing) {
      const adoptedPort = await findExternalGatewayPort(profileName)
      if (adoptedPort !== null) {
        const probe = await probeGateway(adoptedPort, SPAWN_TIMEOUT_MS)
        if (probe.healthy) {
          const entry: GatewayRegistryEntry = {
            httpPort: adoptedPort,
            wsPort: 0, // unknown for externally-managed
            pid: -1,
            startedAt: Date.now(),
          }
          const registry = readGatewayRegistry()
          setRegistryEntry(registry, profileName, entry)
          writeGatewayRegistry(registry)
          return {
            httpPort: adoptedPort,
            wsPort: 0,
            pid: -1,
          }
        }
      }
    }

    // Check if this profile is allocated to another profile's gateway.
    // Allocated profiles do not spawn their own gateway; they route
    // through the target profile's gateway.
    const workspaceConfig = getProfileWorkspaceConfig(profileName)
    if (workspaceConfig.allocatedTo) {
      const targetPort = await findExternalGatewayPort(workspaceConfig.allocatedTo)
      if (targetPort !== null) {
        const probe = await probeGateway(targetPort, SPAWN_TIMEOUT_MS)
        if (probe.healthy) {
          const entry: GatewayRegistryEntry = {
            httpPort: targetPort,
            wsPort: 0, // unknown — owned by target profile
            pid: -2, // allocated to another profile's gateway
            startedAt: Date.now(),
          }
          const registry = readGatewayRegistry()
          setRegistryEntry(registry, profileName, entry)
          writeGatewayRegistry(registry)
          return {
            httpPort: targetPort,
            wsPort: 0,
            pid: -2,
          }
        }
      }
      throw new GatewayStartError(
        `Allocated gateway "${workspaceConfig.allocatedTo}" is not reachable for profile "${profileName}"`,
      )
    }

    // Only validate filesystem when we actually need to spawn
    assertProfileExists(profileName)

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= SPAWN_RETRIES; attempt += 1) {
      try {
        return await trySpawnGateway(profileName)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        // Only retry on port-related or spawn-related failures
        if (attempt < SPAWN_RETRIES) {
          const msg = lastError.message.toLowerCase()
          if (
            msg.includes('eaddrinuse') ||
            msg.includes('address already in use') ||
            msg.includes('failed health check')
          ) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
            continue
          }
        }
        break
      }
    }

    throw lastError ?? new GatewayStartError(`Failed to start gateway for ${profileName}`)
  } finally {
    startingProfiles.delete(profileName)
  }
}

async function trySpawnGateway(profileName: string): Promise<StartResult> {
  const release = await acquirePortLock()
  try {
    const { httpPort, wsPort } = await allocateGatewayPorts()

    const hermesBin = resolveHermesBinary()
    const agentDir = resolveHermesAgentDir()
    const hermesHome = getProfileHermesHome(profileName)

    if (!hermesBin && !agentDir) {
      throw new Error(
        'hermes-agent not found. Run the installer: curl -fsSL https://hermes-workspace.com/install.sh | bash',
      )
    }

    const usingHermesBin = Boolean(hermesBin)

    // Hermes binary doesn't support --port/--ws-port CLI args; use env vars instead.
    // The binary's WS port is always 18789 (hardcoded in upstream).
    const resolvedHttpPort = httpPort
    const resolvedWsPort = usingHermesBin ? 18789 : wsPort

    const command = hermesBin ?? resolveHermesPython(agentDir!)
    const args = usingHermesBin
      ? ['gateway', 'run']
      : [
          '-m',
          'uvicorn',
          'webapi.app:app',
          '--host',
          '0.0.0.0',
          '--port',
          String(httpPort),
        ]

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: hermesHome,
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        PATH: buildHermesPath(agentDir),
        DISCORD_BOT_TOKEN: '',
        GATEWAY_ALLOW_ALL_USERS: 'true',
        ...(usingHermesBin ? { API_SERVER_ENABLED: 'true', API_SERVER_PORT: String(resolvedHttpPort) } : {}),
      },
    }) as ChildProcess

    child.unref()

    // Capture last few lines of stdout/stderr for debugging spawn failures
    const spawnLogs: string[] = []
    const maxSpawnLogs = 20
    function pushLog(line: string) {
      spawnLogs.push(line)
      if (spawnLogs.length > maxSpawnLogs) spawnLogs.shift()
    }
    const stdoutHandler = (chunk: Buffer) => {
      chunk.toString('utf8').split('\n').forEach(pushLog)
    }
    const stderrHandler = (chunk: Buffer) => {
      chunk.toString('utf8').split('\n').forEach((l) => pushLog(`[stderr] ${l}`))
    }
    child.stdout?.on('data', stdoutHandler)
    child.stderr?.on('data', stderrHandler)

    const pid = child.pid!
    const entry: GatewayRegistryEntry = {
      httpPort: resolvedHttpPort,
      wsPort: resolvedWsPort,
      pid,
      startedAt: Date.now(),
    }

    const probeResult = await probeGateway(resolvedHttpPort, SPAWN_TIMEOUT_MS)

    // Stop collecting spawn logs — the gateway is either healthy or dead.
    // Keeping these listeners alive would process every line the gateway
    // writes for its entire lifetime, causing a slow memory/CPU leak.
    child.stdout?.off('data', stdoutHandler)
    child.stderr?.off('data', stderrHandler)

    if (!probeResult.healthy) {
      const unhealthy = probeResult as Extract<typeof probeResult, { healthy: false }>
      const errorMsg = unhealthy.error ?? 'unknown error'
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // ignore
      }
      throw new Error(
        `Gateway failed health check: ${errorMsg}` +
          (spawnLogs.length > 0 ? `\nSpawn logs:\n${spawnLogs.join('\n')}` : ''),
      )
    }

    // Verify the spawned process is still alive.  If another gateway was
    // already listening on this port our probe would have succeeded even
    // though the new process crashed during bind.
    if (!isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // ignore
      }
      throw new Error(
        `Gateway process exited before health check completed` +
          (spawnLogs.length > 0 ? `\nSpawn logs:\n${spawnLogs.join('\n')}` : ''),
      )
    }

    // Verify WS port is actually bound (lightweight TCP connect)
    if (usingHermesBin && process.env.HERMES_TEST_SKIP_WS_VERIFY !== '1') {
      const wsReachable = await verifyWsPort(resolvedWsPort)
      if (!wsReachable) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // ignore
        }
        throw new Error(
          `Gateway WebSocket port ${resolvedWsPort} is not reachable` +
            (spawnLogs.length > 0 ? `\nSpawn logs:\n${spawnLogs.join('\n')}` : ''),
        )
      }
    }

    // Only write to registry AFTER confirming the gateway is healthy
    const registry = readGatewayRegistry()
    setRegistryEntry(registry, profileName, entry)
    writeGatewayRegistry(registry)

    return { httpPort: resolvedHttpPort, wsPort: resolvedWsPort, pid }
  } finally {
    release()
  }
}

export function verifyWsPort(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * Scan the HTTP port range for a gateway belonging to the given profile.
 * Matches by model ID from /v1/models. Returns the port if found.
 */
async function findExternalGatewayPort(profileName: string): Promise<number | null> {
  const baseName = profileName === 'default' ? 'hermes-agent' : profileName
  // Read the profile's own API key so we can auth against externally-managed gateways
  const profileEnv = readProfileEnv(profileName)
  const profileApiKey = profileEnv.API_SERVER_KEY || profileEnv.HERMES_API_TOKEN || ''
  const workspaceApiKey = process.env.HERMES_API_TOKEN || ''

  for (let port = HTTP_PORT_MIN; port <= HTTP_PORT_MIN + 20; port += 1) {
    const probe = await probeGateway(port, 1_000)
    if (!probe.healthy) continue
    try {
      // Try profile's own API key first (for externally-managed gateways),
      // then fall back to workspace token
      const tokensToTry = [profileApiKey, workspaceApiKey].filter(Boolean)
      for (const token of tokensToTry.length > 0 ? tokensToTry : ['']) {
        const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id?: string }> }
          const modelId = data.data?.[0]?.id
          if (modelId === baseName || modelId === profileName) {
            return port
          }
        }
      }
    } catch {
      // ignore — gateway may not expose /v1/models
    }
  }
  return null
}

/**
 * Get the runtime status of a profile's gateway.
 */
export async function getGatewayStatus(
  profileName: string,
): Promise<GatewayStatus> {
  const registry = readGatewayRegistry()
  let entry = getRegistryEntry(registry, profileName)

  if (!entry) {
    // Try to adopt an externally-running gateway (e.g. systemd/hermes CLI)
    const adoptedPort =
      profileName === 'default'
        ? HTTP_PORT_MIN
        : await findExternalGatewayPort(profileName)

    if (adoptedPort !== null) {
      const probe = await probeGateway(adoptedPort, SPAWN_TIMEOUT_MS)
      if (probe.healthy) {
        const adopted: GatewayRegistryEntry = {
          httpPort: adoptedPort,
          wsPort: profileName === 'default' ? 18789 : 0, // unknown for non-default
          pid: -1, // externally managed — we don't own the process
          startedAt: Date.now(),
        }
        setRegistryEntry(registry, profileName, adopted)
        writeGatewayRegistry(registry)
        entry = adopted
      }
    }

    if (!entry) {
      return { status: 'stopped' }
    }
  }

  if (entry.pid !== -1 && entry.pid !== -2 && !isProcessAlive(entry.pid)) {
    // Stale registry entry — process died externally. Clean it up.
    removeRegistryEntry(registry, profileName)
    writeGatewayRegistry(registry)
    return { status: 'stopped' }
  }

  const probe = await probeGateway(entry.httpPort)

  if (probe.healthy) {
    return {
      status: 'healthy',
      pid: entry.pid,
      ports: { http: entry.httpPort, ws: entry.wsPort },
      health: { latencyMs: probe.latencyMs },
    }
  }

  // TypeScript doesn't narrow boolean discriminants reliably — use explicit cast
  const unhealthy = probe as Extract<typeof probe, { healthy: false }>
  return {
    status: 'unhealthy',
    pid: entry.pid,
    ports: { http: entry.httpPort, ws: entry.wsPort },
    health: {
      latencyMs: unhealthy.latencyMs ?? 0,
      error: unhealthy.error,
    },
  }
}

/**
 * Stop a profile's gateway gracefully (SIGTERM → SIGKILL).
 *
 * The registry entry is removed only after the process is confirmed
 * dead or after SIGKILL, preventing untracked zombie processes.
 */
export async function stopGateway(profileName: string): Promise<void> {
  if (stoppingProfiles.has(profileName)) {
    throw new GatewayStopError(
      `Gateway stop already in progress for profile "${profileName}"`,
    )
  }
  stoppingProfiles.add(profileName)

  try {
    const registry = readGatewayRegistry()
    const entry = getRegistryEntry(registry, profileName)

    if (!entry) return

    const { pid } = entry

    // Externally managed (systemd) — never process.kill(-1) which on POSIX
    // sends the signal to every process the user can reach, killing the
    // entire session (TUI, VNC, shell, etc.).
    if (pid === -1) {
      removeClient(profileName)
      try {
        execSync(`systemctl --user stop hermes-gateway-${profileName}.service`, { stdio: 'ignore' })
      } catch {
        // ignore — service may not exist or may already be stopped
      }
      removeRegistryEntry(registry, profileName)
      writeGatewayRegistry(registry)
      return
    }

    if (!isProcessAlive(pid)) {
      // Already dead — just clean up
      removeClient(profileName)
      removeRegistryEntry(registry, profileName)
      writeGatewayRegistry(registry)
      return
    }

    // Remove the WebSocket client before killing the process so no
    // queued RPCs try to use a connection that is about to die.
    removeClient(profileName)

    // SIGTERM
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore
    }

    const exited = await waitForProcessExit(pid, KILL_SIGTERM_MS)

    if (!exited) {
      // SIGKILL
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
      await waitForProcessExit(pid, KILL_SIGKILL_MS)
    }

    // Only remove from registry once the process is confirmed dead
    if (!isProcessAlive(pid)) {
      removeRegistryEntry(registry, profileName)
      writeGatewayRegistry(registry)
    } else {
      throw new GatewayStopError(
        `Failed to stop gateway for "${profileName}": process ${pid} survived SIGKILL`,
      )
    }
  } finally {
    stoppingProfiles.delete(profileName)
  }
}

/**
 * Stop all registered gateways.
 *
 * Stops are serialized to avoid concurrent registry read/write races.
 */
export async function stopAllGateways(): Promise<void> {
  const names = Object.keys(readGatewayRegistry().entries)
  for (const name of names) {
    await stopGateway(name)
  }
}

/**
 * Restart a profile's gateway gracefully.
 *
 * Stops the existing gateway (if any), then starts a fresh one.
 * Preserves the same port allocation when possible.
 */
export async function restartGateway(profileName: string): Promise<StartResult> {
  const warnings: string[] = []
  try {
    await stopGateway(profileName)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[gateway-orchestrator] stopGateway failed during restart for ${profileName}:`,
      err,
    )
    warnings.push(`Previous gateway could not be stopped: ${errMsg}`)
  }
  resetMonitorState(profileName)
  const result = await startGateway(profileName)
  if (warnings.length > 0) {
    return { ...result, warnings }
  }
  return result
}

/* — shutdown hooks — */
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`[gateway] Received ${signal}, stopping all gateways...`)
    try {
      // Stop health monitor first to prevent it from trying to restart
      // gateways while we are shutting them down.
      const { stopMonitoring } = await import('./gateway-monitor')
      stopMonitoring()
    } catch {
      // ignore — monitor may not be started
    }
    try {
      // @ts-ignore - deferred file: agent-messaging port pending Tier 2 completion
      const { prepareForShutdown } = await import(
        // @ts-ignore - deferred file: agent-messaging port pending Tier 2 completion
        './agent-messaging'
      )
      prepareForShutdown()
    } catch {
      // ignore — messaging may not be initialized
    }
    try {
      await stopAllGateways()
    } catch {
      // ignore
    }
    process.exit(0)
  }
  if (process.listenerCount('SIGTERM') === 0) {
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
  }
  if (process.listenerCount('SIGINT') === 0) {
    process.on('SIGINT', () => void shutdown('SIGINT'))
  }
}

/* ── startup initialization ── */
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  try {
    initializeGatewayRegistry()
  } catch {
    // ignore startup reconciliation failure
  }

  /* — background stale-PID reconciliation (every 30s) — */
  if (!(globalThis as any).__hermesGatewayReconcileInterval) {
    (globalThis as any).__hermesGatewayReconcileInterval = setInterval(() => {
      try {
        initializeGatewayRegistry()
      } catch {
        // ignore background reconciliation failure
      }
    }, 30_000)
  }

  /* — start gateway health monitor — */
  import('./gateway-monitor')
    .then(({ startMonitoring }) => startMonitoring())
    .catch(() => {
      // ignore — monitor start failure should not block server startup
    })
}
