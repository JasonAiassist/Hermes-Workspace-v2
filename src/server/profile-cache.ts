import { DEFAULT_CACHE_TTL_MS } from './constants'

const NO_MODEL_SENTINEL = null

type CacheEntry = {
  model: string | typeof NO_MODEL_SENTINEL
  timestamp: number
}

const profileModelCache = new Map<string, CacheEntry>()
const MAX_CACHE_SIZE = 100

export type CacheResult =
  | { hit: true; model: string }
  | { hit: false }

function evictOldestIfNeeded(): void {
  if (profileModelCache.size > MAX_CACHE_SIZE) {
    const oldestKey = profileModelCache.keys().next().value
    if (oldestKey !== undefined) {
      profileModelCache.delete(oldestKey)
    }
  }
}

export function getCachedModel(profileName: string): CacheResult {
  const entry = profileModelCache.get(profileName)
  if (!entry) return { hit: false }
  if (Date.now() - entry.timestamp > DEFAULT_CACHE_TTL_MS) {
    profileModelCache.delete(profileName)
    return { hit: false }
  }
  return entry.model === NO_MODEL_SENTINEL
    ? { hit: true, model: '' }
    : { hit: true, model: entry.model }
}

export function setCachedModel(profileName: string, model: string | undefined): void {
  profileModelCache.set(profileName, {
    model: model || NO_MODEL_SENTINEL,
    timestamp: Date.now(),
  })
  evictOldestIfNeeded()
}

/**
 * Clear the profile model cache for a specific profile, or all profiles.
 * Call after profile updates that might change the model.
 */
export function clearProfileModelCache(profileName?: string): void {
  if (profileName) {
    profileModelCache.delete(profileName)
  } else {
    profileModelCache.clear()
  }
}