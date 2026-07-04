import fs from 'node:fs'
import path from 'node:path'
import { getHermesHome } from './hermes-home'
const ACTIVE_PROFILE_CACHE_TTL_MS = 1_000

export type ActiveProfileLogger = {
  warn: (...args: unknown[]) => void
}

let logger: ActiveProfileLogger = console

export function setActiveProfileLogger(l: ActiveProfileLogger): void {
  logger = l
}

export function getActiveProfileLogger(): ActiveProfileLogger {
  return logger
}

const cache = new Map<string, { value: string; timestamp: number }>()

export function getActiveProfileName(hermesRoot?: string): string {
  const root = hermesRoot ?? getHermesHome()
  const entry = cache.get(root)
  if (entry) {
    if (Date.now() - entry.timestamp < ACTIVE_PROFILE_CACHE_TTL_MS) {
      return entry.value
    }
    cache.delete(root)
  }

  try {
    const activeProfilePath = path.join(root, 'active_profile')
    if (fs.existsSync(activeProfilePath)) {
      const raw = fs.readFileSync(activeProfilePath, 'utf-8').trim().toLowerCase()
      if (raw) {
        cache.set(root, { value: raw, timestamp: Date.now() })
        return raw
      }
    }
  } catch (err) {
    logger.warn('Failed to read active_profile', String(err))
  }
  return 'default'
}

export function clearActiveProfileCache(hermesRoot?: string): void {
  if (hermesRoot) {
    cache.delete(hermesRoot)
  } else {
    cache.clear()
  }
}