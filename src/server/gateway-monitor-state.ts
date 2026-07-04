/**
 * Gateway monitor state — extracted to avoid circular dependency with
 * gateway-orchestrator.ts.
 *
 * Both gateway-monitor.ts (high-level policy) and gateway-orchestrator.ts
 * (low-level process management) import from this module.
 */

import type { ProbeResult } from './gateway-health'

export type RestartRecord = {
  attempts: number
  lastAttemptAt: number
  state: 'healthy' | 'restarting' | 'failed'
  lastProbe?: ProbeResult
}

export type GatewayMonitorState = {
  profile: string
  state: 'healthy' | 'restarting' | 'failed'
  attempts: number
  lastAttemptAt: number | null
  lastProbe?: ProbeResult
}

const restartState = new Map<string, RestartRecord>()

export function getRecord(profileName: string): RestartRecord {
  let rec = restartState.get(profileName)
  if (!rec) {
    rec = { attempts: 0, lastAttemptAt: 0, state: 'healthy' }
    restartState.set(profileName, rec)
  }
  return rec
}

export function resetRecord(profileName: string): void {
  restartState.set(profileName, {
    attempts: 0,
    lastAttemptAt: 0,
    state: 'healthy',
  })
}

export function deleteMonitorState(profileName: string): void {
  restartState.delete(profileName)
}

export function getAllMonitorStates(): GatewayMonitorState[] {
  return Array.from(restartState.entries()).map(([profile, rec]) => ({
    profile,
    state: rec.state,
    attempts: rec.attempts,
    lastAttemptAt: rec.lastAttemptAt || null,
    lastProbe: rec.lastProbe,
  }))
}

export function getMonitorState(profileName: string): GatewayMonitorState | undefined {
  const rec = restartState.get(profileName)
  if (!rec) return undefined
  return {
    profile: profileName,
    state: rec.state,
    attempts: rec.attempts,
    lastAttemptAt: rec.lastAttemptAt || null,
    lastProbe: rec.lastProbe,
  }
}

export function resetMonitorState(profileName: string): void {
  resetRecord(profileName)
}
