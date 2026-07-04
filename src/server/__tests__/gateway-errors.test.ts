import { describe, it, expect } from 'vitest'
import {
  ProfileNotFoundError,
  GatewayStartError,
  GatewayStopError,
  GatewayNotRunningError,
} from '../gateway-errors'

describe('ProfileNotFoundError', () => {
  it('sets name and message with profile name', () => {
    const err = new ProfileNotFoundError('sage')
    expect(err.name).toBe('ProfileNotFoundError')
    expect(err.message).toBe('Profile directory not found: sage')
  })

  it('is an instance of Error', () => {
    const err = new ProfileNotFoundError('sage')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProfileNotFoundError)
  })
})

describe('GatewayStartError', () => {
  it('sets name and message', () => {
    const err = new GatewayStartError('port 8642 in use')
    expect(err.name).toBe('GatewayStartError')
    expect(err.message).toBe('port 8642 in use')
  })

  it('is an instance of Error', () => {
    const err = new GatewayStartError('boom')
    expect(err).toBeInstanceOf(GatewayStartError)
  })
})

describe('GatewayStopError', () => {
  it('sets name and message', () => {
    const err = new GatewayStopError('process not found')
    expect(err.name).toBe('GatewayStopError')
    expect(err.message).toBe('process not found')
  })
})

describe('GatewayNotRunningError', () => {
  it('sets name, message, and profileName field', () => {
    const err = new GatewayNotRunningError('cto')
    expect(err.name).toBe('GatewayNotRunningError')
    expect(err.message).toBe("Gateway for profile 'cto' is not running")
    expect(err.profileName).toBe('cto')
  })

  it('exposes profileName for callers to handle differently', () => {
    const err = new GatewayNotRunningError('jarvis')
    // Callers use instance/profileName to distinguish "gateway not started"
    // from generic connection errors
    if (err instanceof GatewayNotRunningError) {
      expect(err.profileName).toBe('jarvis')
    } else {
      throw new Error('expected GatewayNotRunningError')
    }
  })
})

describe('error differentiation', () => {
  it('different error types are not interchangeable via instanceof', () => {
    const startErr = new GatewayStartError('x')
    const stopErr = new GatewayStopError('x')
    expect(startErr).not.toBeInstanceOf(GatewayStopError)
    expect(stopErr).not.toBeInstanceOf(GatewayStartError)
  })
})