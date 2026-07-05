import { useQuery } from '@tanstack/react-query'

/**
 * Per-profile gateway runtime status, mirroring the shape returned by the
 * v2 gateway-orchestrator `getGatewayStatus` (src/server/gateway-orchestrator.ts).
 */
export type ProfileGatewayStatus = {
  status: 'stopped' | 'healthy' | 'unhealthy'
  pid?: number
  ports?: { http: number; ws: number }
  health?: { latencyMs: number; error?: string }
}

export type ProfileStatusesResponse = {
  ok: true
  statuses: Record<string, ProfileGatewayStatus>
}

const STATUS_ALL_KEY = ['profiles', 'gateway-statuses'] as const

/**
 * Fetch the batched gateway-status map for all profiles.
 *
 * Throws when the endpoint returns a non-2xx response, surfacing the
 * response body text when available so the consumer can render a useful
 * error state instead of an opaque status code.
 */
async function fetchStatusAll(): Promise<Record<string, ProfileGatewayStatus>> {
  const res = await fetch('/api/profiles/status-all')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Status fetch failed (${res.status})`)
  }
  const data = (await res.json()) as ProfileStatusesResponse
  return data.statuses
}

/**
 * Batch-fetch gateway statuses for all profiles, refreshing every 5s so the
 * profile cards reflect live runtime state without manual reloads.
 */
export function useProfileGatewayStatuses() {
  return useQuery({
    queryKey: STATUS_ALL_KEY,
    queryFn: fetchStatusAll,
    refetchInterval: 5_000,
  })
}

/* Re-export mutations from canonical location to avoid duplication */
export {
  useStartGatewayMutation,
  useStopGatewayMutation,
} from './use-profile-mutations'
