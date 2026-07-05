import { useMutation, useQueryClient } from '@tanstack/react-query'

/**
 * Profile mutation hooks for the multi-gateway UI.
 *
 * Each hook POSTs to a `/api/profiles/...` endpoint and invalidates the
 * relevant react-query cache keys so the list/status views re-fetch.
 *
 * These hooks integrate with the v2 multi-gateway backend
 * (gateway-orchestrator start/stop/restart, profile-cache list,
 * profile-clone) via the HTTP routes that wrap them.
 */

const STATUS_ALL_KEY = ['profiles', 'gateway-statuses'] as const
const PROFILES_LIST_KEY = ['profiles', 'list'] as const

/**
 * POST JSON helper shared by every profile mutation.
 *
 * Throws an Error carrying `.details` (the parsed error payload) when the
 * server responds non-2xx or returns a body with an `error` field, so callers
 * can surface a meaningful toast message.
 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string
  }
  if (!response.ok || payload?.error) {
    const err = new Error(
      payload?.error || `Request failed (${response.status})`,
    )
    ;(err as Error & { details?: unknown }).details = payload
    throw err
  }
  return payload
}

/** Start a gateway for a profile; invalidates the status batch cache. */
export function useStartGatewayMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => postJson('/api/profiles/start', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_ALL_KEY })
    },
  })
}

/** Stop a gateway for a profile; invalidates the status batch cache. */
export function useStopGatewayMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => postJson('/api/profiles/stop', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_ALL_KEY })
    },
  })
}

/** Activate a profile (set it as the active profile); invalidates the list. */
export function useActivateProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => postJson('/api/profiles/activate', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILES_LIST_KEY })
    },
  })
}

/** Create a new profile (optionally cloning from an existing one). */
export function useCreateProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      name: string
      cloneFrom?: string
      copyMemory?: boolean
      model?: string
      provider?: string
      persistent?: boolean
      role?: string
      roleDescription?: string
    }) => postJson('/api/profiles/create', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
}

/** Delete a profile. */
export function useDeleteProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => postJson('/api/profiles/delete', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
}

/** Rename a profile. */
export function useRenameProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { oldName: string; newName: string }) =>
      postJson('/api/profiles/rename', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
}

/**
 * Clone an existing profile into a new one.
 *
 * Path-encodes the source profile name and POSTs `{ newName, copyMemory }`.
 */
export function useCloneProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; newName: string; copyMemory?: boolean }) =>
      postJson(`/api/profiles/${encodeURIComponent(body.name)}/clone`, {
        newName: body.newName,
        copyMemory: body.copyMemory,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })
}

/** Save (write) the profile config.yaml. */
export function useSaveConfigMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; configYaml: string }) =>
      postJson('/api/profiles/config-write', body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['profiles', 'config', variables.name],
      })
      void queryClient.invalidateQueries({
        queryKey: ['profiles', 'read', variables.name],
      })
    },
  })
}

/** Save (write) the profile SOUL.md. */
export function useSaveSoulMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; soul: string }) =>
      postJson('/api/profiles/soul-write', body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['profiles', 'soul', variables.name],
      })
    },
  })
}
