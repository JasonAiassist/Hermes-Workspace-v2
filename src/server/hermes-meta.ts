/**
 * Hermes API — meta endpoints.
 *
 * Configuration, model listing, skills catalog, and memory operations.
 * These are read-mostly with one PATCH endpoint for config.
 */

import {
  hermesGet,
  hermesPatch,
  resolveBaseUrl,
  type HermesConfig,
} from './hermes-api-client'

// ── Memory ───────────────────────────────────────────────────────────

export async function getMemory(profileName?: string): Promise<unknown> {
  return hermesGet('/api/memory', profileName)
}

// ── Skills ───────────────────────────────────────────────────────────

export async function listSkills(profileName?: string): Promise<unknown> {
  return hermesGet('/api/skills', profileName)
}

export async function getSkill(
  name: string,
  profileName?: string,
): Promise<unknown> {
  return hermesGet(`/api/skills/${encodeURIComponent(name)}`, profileName)
}

export async function getSkillCategories(
  profileName?: string,
): Promise<unknown> {
  return hermesGet('/api/skills/categories', profileName)
}

// ── Config ───────────────────────────────────────────────────────────

export async function getConfig(profileName?: string): Promise<HermesConfig> {
  return hermesGet<HermesConfig>('/api/config', profileName)
}

export async function patchConfig(
  patch: Record<string, unknown>,
  profileName?: string,
): Promise<Record<string, unknown>> {
  return hermesPatch<Record<string, unknown>>('/api/config', patch, profileName)
}

// ── Models ───────────────────────────────────────────────────────────

export type ListModelsResponse = {
  object: string
  data: Array<{ id: string; object: string }>
}

export async function listModels(
  profileName?: string,
): Promise<ListModelsResponse> {
  return hermesGet<ListModelsResponse>('/v1/models', profileName)
}

// ── Connection check ─────────────────────────────────────────────────

/**
 * Lightweight health probe. Returns true when `/health` responds OK
 * within 3s. Used by the UI to show the connection indicator.
 */
export async function isHermesAvailable(
  profileName?: string,
): Promise<boolean> {
  try {
    const base = await resolveBaseUrl(profileName)
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Returns the raw `/health` payload. Used by background health
 * monitors that want the upstream status string.
 */
export async function checkHealth(
  profileName?: string,
): Promise<{ status: string }> {
  return hermesGet<{ status: string }>('/health', profileName)
}