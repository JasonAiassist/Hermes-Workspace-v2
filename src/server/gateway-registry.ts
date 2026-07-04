/**
 * Gateway registry persistence.
 *
 * Maintains a JSON file at ~/.hermes/gateway-registry.json that maps
 * profile names to their running gateway process metadata.
 *
 * Writes are atomic (temp file + rename) to prevent corruption.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { cleanupStaleTempFiles } from './config-reader'

export type GatewayRegistryEntry = {
  httpPort: number
  wsPort: number
  pid: number
  startedAt: number
}

export type GatewayRegistry = {
  version: number
  entries: Record<string, GatewayRegistryEntry>
}

const REGISTRY_VERSION = 1
const REGISTRY_FILE_NAME = 'gateway-registry.json'

function getRegistryPath(): string {
  const home = process.env.HERMES_HOME ?? join(homedir(), '.hermes')
  return join(home, REGISTRY_FILE_NAME)
}

/**
 * Get the Hermes home directory for a profile.
 * For 'default', returns the base HERMES_HOME.
 * For named profiles, returns HERMES_HOME/profiles/<name>.
 */
export function getProfileHermesHome(profileName: string): string {
  const base = process.env.HERMES_HOME ?? join(homedir(), '.hermes')
  if (profileName === 'default') return base
  return join(base, 'profiles', profileName)
}

function emptyRegistry(): GatewayRegistry {
  return { version: REGISTRY_VERSION, entries: {} }
}

/**
 * Read the gateway registry from disk.
 * Returns an empty registry if the file doesn't exist or is corrupt.
 */
export function readGatewayRegistry(): GatewayRegistry {
  const filePath = getRegistryPath()
  if (!existsSync(filePath)) {
    return emptyRegistry()
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown

    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      'entries' in parsed &&
      typeof (parsed as Record<string, unknown>).version === 'number' &&
      typeof (parsed as Record<string, unknown>).entries === 'object'
    ) {
      const reg = parsed as GatewayRegistry
      // Validate each entry has numeric ports and pid
      for (const entry of Object.values(reg.entries)) {
        if (
          typeof entry.httpPort !== 'number' ||
          typeof entry.wsPort !== 'number' ||
          typeof entry.pid !== 'number' ||
          typeof entry.startedAt !== 'number'
        ) {
          return emptyRegistry()
        }
      }
      return reg
    }
  } catch {
    // Corrupt registry — start fresh
  }

  return emptyRegistry()
}

/**
 * Write the gateway registry to disk atomically.
 *
 * Writes to a temp file first, then renames it into place.
 * This prevents half-written files on crash or power loss.
 */
export function writeGatewayRegistry(registry: GatewayRegistry): void {
  const filePath = getRegistryPath()
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tempPath = `${filePath}.tmp.${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf-8')

  try {
    renameSync(tempPath, filePath)
  } catch {
    // Clean up temp file on failure
    try {
      unlinkSync(tempPath)
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`Failed to write gateway registry to ${filePath}`)
  }
}

/**
 * Get a single registry entry for a profile.
 * Returns undefined if the profile has no running gateway recorded.
 */
export function getRegistryEntry(
  registry: GatewayRegistry,
  profileName: string,
): GatewayRegistryEntry | undefined {
  return registry.entries[profileName]
}

/**
 * Set a registry entry for a profile.
 * Mutates the registry object in place.
 */
export function setRegistryEntry(
  registry: GatewayRegistry,
  profileName: string,
  entry: GatewayRegistryEntry,
): void {
  registry.entries[profileName] = entry
}

/**
 * Remove a registry entry for a profile.
 * Mutates the registry object in place.
 */
export function removeRegistryEntry(
  registry: GatewayRegistry,
  profileName: string,
): void {
  delete registry.entries[profileName]
}

/**
 * Check whether a process with the given PID is still alive.
 * Uses signal 0 (no actual signal sent, just permission check).
 * pid === -1 means externally managed (e.g. systemd) — always reported as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid === -1) return true   // externally managed
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Reconcile the registry: remove entries whose PIDs are no longer alive.
 * Returns a new registry with stale entries removed.
 */
export function reconcileRegistry(registry: GatewayRegistry): GatewayRegistry {
  const cleaned: GatewayRegistry = {
    version: registry.version,
    entries: {},
  }

  for (const [profileName, entry] of Object.entries(registry.entries)) {
    if (isProcessAlive(entry.pid)) {
      cleaned.entries[profileName] = entry
    }
  }

  return cleaned
}

/**
 * One-time server startup initialization.
 * Reconciles the registry to remove stale entries from previous runs.
 * Safe to call multiple times (idempotent).
 */
export function initializeGatewayRegistry(): void {
  const reg = readGatewayRegistry()
  const cleaned = reconcileRegistry(reg)
  if (Object.keys(cleaned.entries).length !== Object.keys(reg.entries).length) {
    writeGatewayRegistry(cleaned)
  }
  // Clean up orphaned temp files from previous crashes (M4)
  cleanupStaleTempFiles(dirname(getRegistryPath()))
}
