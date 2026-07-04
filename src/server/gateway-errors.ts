/**
 * Typed error classes for gateway operations.
 *
 * Used by route handlers to return precise HTTP status codes
 * without fragile string-matching on error messages.
 */

export class ProfileNotFoundError extends Error {
  constructor(profileName: string) {
    super(`Profile directory not found: ${profileName}`)
    this.name = 'ProfileNotFoundError'
  }
}

export class GatewayStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayStartError'
  }
}

export class GatewayStopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayStopError'
  }
}

/**
 * Thrown when an API call is made to a profile whose gateway is not running.
 * This allows callers to distinguish "gateway not started yet" from
 * "connection error to a running gateway."
 */
export class GatewayNotRunningError extends Error {
  readonly profileName: string

  constructor(profileName: string) {
    super(`Gateway for profile '${profileName}' is not running`)
    this.name = 'GatewayNotRunningError'
    this.profileName = profileName
  }
}