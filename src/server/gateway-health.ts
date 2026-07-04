/**
 * HTTP health probe for spawned gateway processes.
 *
 * Discovers the correct health endpoint dynamically:
 *   1. GET /health
 *   2. GET /api/health
 *   3. GET /api/sessions (proxy — 200 means alive)
 *
 * This avoids hard-coding a single endpoint that may differ between
 * gateway versions or deployment modes.
 */

const DEFAULT_TIMEOUT_MS = 2_000

export type ProbeResult =
  | { healthy: true; latencyMs: number }
  | { healthy: false; latencyMs?: number; error: string }

/**
 * Probe a single endpoint and return the result.
 */
async function probeEndpoint(
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    const latencyMs = Math.round(performance.now() - start)

    if (response.ok) {
      return { healthy: true, latencyMs }
    }
    return {
      healthy: false,
      latencyMs,
      error: `HTTP ${response.status}`,
    }
  } catch (error) {
    clearTimeout(timer)
    const latencyMs = Math.round(performance.now() - start)
    const message =
      error instanceof Error ? error.message : String(error)

    if (message.includes('abort') || message.includes('AbortError')) {
      return { healthy: false, latencyMs, error: 'timeout' }
    }
    return { healthy: false, latencyMs, error: message }
  }
}

function isConnectionRefused(result: ProbeResult): boolean {
  if (result.healthy) return false
  const err = (result as Extract<ProbeResult, { healthy: false }>).error.toLowerCase()
  return (
    err.includes('econnrefused') ||
    err.includes('connection refused') ||
    err.includes('fetch failed')
  )
}

const HEALTH_ENDPOINTS = ['/health', '/api/health']
const PROXY_ENDPOINT = '/api/sessions'

/**
 * Probe a gateway running on the given HTTP port.
 *
 * Tries canonical health endpoints first, falling back to a lightweight
 * proxy endpoint if none are exposed.
 *
 * Short-circuits on connection refused — if nothing is listening, there is
 * no point trying alternate endpoints.
 */
export async function probeGateway(
  httpPort: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${httpPort}`

  // 1. Try known health endpoints
  let firstFailure: ProbeResult | null = null
  for (const path of HEALTH_ENDPOINTS) {
    const result = await probeEndpoint(`${base}${path}`, timeoutMs)
    if (result.healthy) {
      return result
    }
    if (!firstFailure) {
      firstFailure = result
    }
    // Nothing listening — don't waste time on other endpoints
    if (isConnectionRefused(result)) {
      return result
    }
  }

  // 2. Fall back to proxy endpoint (any 200 = alive)
  const proxyResult = await probeEndpoint(
    `${base}${PROXY_ENDPOINT}`,
    timeoutMs,
  )
  if (proxyResult.healthy) {
    return proxyResult
  }

  // 3. Return the first health endpoint failure (most informative)
  return firstFailure ?? proxyResult
}
