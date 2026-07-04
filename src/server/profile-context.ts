/**
 * profile-context.ts
 *
 * S2-T2/S2-T3: AsyncLocalStorage context for routing HTTP and WebSocket requests
 * to the correct per-profile gateway without threading profileName through every function.
 *
 * Usage:
 *   // Pattern 1: scoped with run() — context is automatically restored after fn returns
 *   await withActiveProfile('sage', async () => {
 *     // profileContextStorage.getStore() === 'sage'
 *     await doNestedWork() // context preserved
 *   })
 *
 *   // Pattern 2: enterWith (for request middleware boundaries)
 *   const prev = profileContextStorage.getStore()
 *   profileContextStorage.enterWith({ profileName: 'sage' })
 *   try {
 *     // context is active
 *   } finally {
 *     if (prev) profileContextStorage.enterWith(prev)
 *   }
 *
 *   // Pattern 3: HTTP route wrapper (S2-T3 critical wiring)
 *   POST: async ({ request }) => {
 *     return withProfileContext(request, async () => {
 *       // all hermes-api calls route to the correct profile gateway
 *       return handleSendStream(request)
 *     })
 *   }
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { getActiveProfileName } from './active-profile'

export interface ProfileContext {
  profileName: string
}

/** Module-level storage — lives for the duration of a single request/operation */
export const profileContextStorage = new AsyncLocalStorage<ProfileContext>()

/**
 * Wrap an async function with a specific profile context.
 * The context is active inside `fn` and automatically restored after it resolves.
 *
 * @example
 *   await withActiveProfile('sage', async () => {
 *     const profile = getActiveProfileContext() // 'sage'
 *     await doWork() // context preserved in nested calls
 *   })
 *   // context restored here
 */
export async function withActiveProfile<T>(
  profileName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const store: ProfileContext = { profileName }
  // Wrap the entire async call chain so run() establishes the scope BEFORE
  // any await points. This ensures the async context is active for all
  // downstream async operations, including those that Vitest's microtask
  // scheduler might interleave.
  return profileContextStorage.run(store, () => fn())
}

/**
 * Get the active profile name from the current async context.
 * Returns the profile stored by withActiveProfile() / setActiveProfileContext(),
 * or undefined if no context has been set (callers should fall back to
 * getActiveProfileName() which reads the filesystem).
 */
export function getActiveProfileContext(): string | undefined {
  return profileContextStorage.getStore()?.profileName
}

/**
 * HTTP route wrapper that sets the AsyncLocalStorage profile context for the
 * duration of the handler.
 *
 * Profile resolution order:
 *   1. `X-Hermes-Profile` request header (explicit per-request override)
 *   2. Active profile from the profile registry (HERMES_ACTIVE_PROFILE)
 *
 * This is the critical S2-T3 wiring: without this, getActiveProfileContext()
 * always returns undefined and all HTTP traffic falls back to the legacy
 * singleton gateway regardless of the user's active profile.
 *
 * @param request  - The incoming HTTP request (used to read X-Hermes-Profile header)
 * @param fn       - The route handler to wrap
 * @param hermesRoot - Optional HERMES_HOME override for testing
 */
export async function withProfileContext<T>(
  request: Request,
  fn: () => Promise<T>,
  hermesRoot?: string,
): Promise<T> {
  // 1. Check for explicit per-request header override
  const headerProfile = request.headers.get('X-Hermes-Profile')
  if (headerProfile && headerProfile.trim()) {
    const name = headerProfile.trim()
    return withActiveProfile(name, fn)
  }

  // 2. Fall back to active profile from the profile registry
  const activeProfile = getActiveProfileName(hermesRoot)
  return withActiveProfile(activeProfile, fn)
}