/**
 * Hermes API HTTP client primitives.
 *
 * Low-level: GET / POST / PATCH / DELETE wrappers + auth header + base
 * URL resolution. The v2 port drops the dashboard-API fallback that
 * the old fork used (upstream v2 has no dashboard-API; all requests
 * go through the gateway-pool).
 */

import { BEARER_TOKEN, CLAUDE_API } from './gateway-capabilities'
import { resolveGatewayHttpUrl } from './gateway-pool'
import { getActiveProfileName } from './active-profile'
import { getActiveProfileContext, withActiveProfile } from './profile-context'
import { ProfileNotFoundError } from './gateway-errors'

export function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

/**
 * Resolve the gateway base URL for a given profile.
 *
 * Resolution order:
 *   1. Explicit profileName → resolveGatewayHttpUrl(profileName)
 *      (throws ProfileNotFoundError if missing — caller asked for it)
 *   2. AsyncLocalStorage profile context → resolveGatewayHttpUrl(name)
 *   3. Active profile file → resolveGatewayHttpUrl(name)
 *   4. Legacy singleton: CLAUDE_API (e.g. http://127.0.0.1:8642)
 */
export async function resolveBaseUrl(profileName?: string): Promise<string> {
  const name =
    profileName ?? getActiveProfileContext() ?? getActiveProfileName()
  if (!name) return CLAUDE_API

  try {
    return await resolveGatewayHttpUrl(name)
  } catch (error) {
    // Only swallow ProfileNotFoundError when the caller did NOT pass
    // an explicit profileName — i.e. the resolved name came from
    // AsyncLocalStorage or the active-profile file. In that case we
    // fall back to the legacy singleton. If the caller explicitly
    // named a profile that doesn't exist, propagate.
    const isImplicit = profileName === undefined
    const isProfileMissing =
      error instanceof ProfileNotFoundError ||
      (error instanceof Error && error.name === 'ProfileNotFoundError')

    if (isImplicit && isProfileMissing) {
      return CLAUDE_API
    }
    throw error
  }
}

/**
 * Run `fn` inside the AsyncLocalStorage profile context if a name was
 * supplied. Otherwise call `fn` directly. Used so downstream gateway
 * calls inside `fn` resolve to the named profile without the caller
 * having to thread it through every layer.
 */
export async function withProfile<T>(
  profileName: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (profileName) {
    return withActiveProfile(profileName, fn)
  }
  return fn()
}

// ── HTTP verbs ────────────────────────────────────────────────────────

export async function hermesGet<T>(
  path: string,
  profileName?: string,
): Promise<T> {
  const base = await resolveBaseUrl(profileName)
  const res = await fetch(`${base}${path}`, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Hermes API GET ${path}: ${res.status} ${body}`)
  }
  return (await res.json()) as T
}

export async function hermesPost<T>(
  path: string,
  body?: unknown,
  profileName?: string,
): Promise<T> {
  const base = await resolveBaseUrl(profileName)
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes API POST ${path}: ${res.status} ${text}`)
  }
  return (await res.json()) as T
}

export async function hermesPatch<T>(
  path: string,
  body: unknown,
  profileName?: string,
): Promise<T> {
  const base = await resolveBaseUrl(profileName)
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes API PATCH ${path}: ${res.status} ${text}`)
  }
  return (await res.json()) as T
}

export async function hermesDelete(
  path: string,
  profileName?: string,
): Promise<void> {
  const base = await resolveBaseUrl(profileName)
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes API DELETE ${path}: ${res.status} ${text}`)
  }
}

// ── Domain types shared across sessions / stream / meta ──────────────

export type HermesSession = {
  id: string
  source?: string
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at?: number
  ended_at?: number | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  parent_session_id?: string | null
  last_active?: number | null
  preview?: string | null
}

export type HermesMessage = {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id?: string | null
  tool_calls?: Array<unknown> | string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
}

export type HermesConfig = {
  model?: string
  provider?: string
  [key: string]: unknown
}