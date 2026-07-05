/**
 * Session key helpers — profile prefix parsing.
 *
 * The Hermes gateway singleton does not scope sessions per profile,
 * so multi-profile deployments encode the profile in the session key:
 *   `profile:<name>:<bare-session-id>`
 *
 * These helpers convert between qualified and bare forms. Use them
 * whenever accepting a `sessionKey` from a UI component that may or may
 * not have included the prefix.
 */

const PROFILE_PREFIX = 'profile:'

export function isFullyQualifiedSessionKey(key: string | unknown): boolean {
  return typeof key === 'string' && key.startsWith(PROFILE_PREFIX)
}

/**
 * Strip the `profile:<name>:` prefix from a session key and return the
 * bare ID. Returns the key unchanged if it is not fully-qualified.
 */
export function stripProfilePrefix(key: string): string {
  if (!isFullyQualifiedSessionKey(key)) {
    return key
  }
  const withoutPrefix = key.slice(PROFILE_PREFIX.length)
  const colonIdx = withoutPrefix.indexOf(':')
  return colonIdx >= 0 ? withoutPrefix.slice(colonIdx + 1) : withoutPrefix
}

/**
 * Extract the profile name from a fully-qualified session key.
 * Returns undefined for bare keys, empty strings, undefined input,
 * or malformed prefixes with an empty profile segment.
 */
export function extractProfileName(
  key: string | undefined | unknown,
): string | undefined {
  if (!key || typeof key !== 'string') {
    return undefined
  }
  if (!isFullyQualifiedSessionKey(key)) {
    return undefined
  }
  const withoutPrefix = key.slice(PROFILE_PREFIX.length)
  const colonIdx = withoutPrefix.indexOf(':')
  const profile =
    colonIdx >= 0 ? withoutPrefix.slice(0, colonIdx) : withoutPrefix
  return profile.length > 0 ? profile : undefined
}