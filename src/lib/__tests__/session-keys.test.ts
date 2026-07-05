import { describe, it, expect } from 'vitest'
import {
  isFullyQualifiedSessionKey,
  stripProfilePrefix,
  extractProfileName,
} from '../session-keys'

describe('isFullyQualifiedSessionKey', () => {
  it('returns true for fully-qualified keys', () => {
    expect(isFullyQualifiedSessionKey('profile:sage:abc-123')).toBe(true)
    expect(isFullyQualifiedSessionKey('profile:my-agent_v2:def-456')).toBe(true)
  })

  it('returns false for bare keys', () => {
    expect(isFullyQualifiedSessionKey('abc-123')).toBe(false)
    expect(isFullyQualifiedSessionKey('main')).toBe(false)
    expect(isFullyQualifiedSessionKey('new')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isFullyQualifiedSessionKey('')).toBe(false)
  })

  it('returns false for malformed prefixes', () => {
    expect(isFullyQualifiedSessionKey('profile-only')).toBe(false)
    expect(isFullyQualifiedSessionKey('PROFILE:sage:abc')).toBe(false)
  })

  it('returns true for prefix-only strings (malformed but prefixed)', () => {
    expect(isFullyQualifiedSessionKey('profile:')).toBe(true)
    expect(isFullyQualifiedSessionKey('profile:sage')).toBe(true)
  })
})

describe('stripProfilePrefix', () => {
  it('strips prefix from fully-qualified keys', () => {
    expect(stripProfilePrefix('profile:sage:abc-123')).toBe('abc-123')
    expect(stripProfilePrefix('profile:my-agent_v2:def-456')).toBe('def-456')
  })

  it('returns bare key unchanged', () => {
    expect(stripProfilePrefix('abc-123')).toBe('abc-123')
    expect(stripProfilePrefix('main')).toBe('main')
  })

  it('returns empty string unchanged', () => {
    expect(stripProfilePrefix('')).toBe('')
  })

  it('handles keys with multiple colons after prefix', () => {
    expect(stripProfilePrefix('profile:sage:extra:bits')).toBe('extra:bits')
  })

  it('handles malformed prefix (only 2 colons) by returning everything after second colon', () => {
    expect(stripProfilePrefix('profile:sage')).toBe('sage')
  })

  it('handles keys starting with profile but no second colon', () => {
    expect(stripProfilePrefix('profile-only')).toBe('profile-only')
  })
})

describe('extractProfileName', () => {
  it('extracts profile from fully-qualified key', () => {
    expect(extractProfileName('profile:sage:abc-123')).toBe('sage')
    expect(extractProfileName('profile:jarvis:def-456')).toBe('jarvis')
  })

  it('extracts profile with hyphens and underscores', () => {
    expect(extractProfileName('profile:my-agent_v2:abc-123')).toBe('my-agent_v2')
  })

  it('returns undefined for bare keys', () => {
    expect(extractProfileName('abc-123')).toBeUndefined()
    expect(extractProfileName('main')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(extractProfileName('')).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(extractProfileName(undefined)).toBeUndefined()
  })

  it('returns undefined for null input', () => {
    expect(extractProfileName(null as unknown as string)).toBeUndefined()
  })

  it('extracts profile even from malformed prefix (only 2 colons)', () => {
    expect(extractProfileName('profile:sage')).toBe('sage')
  })

  it('returns undefined for keys starting with profile but no second colon', () => {
    expect(extractProfileName('profile-only')).toBeUndefined()
  })

  it('handles keys with multiple colons after profile', () => {
    expect(extractProfileName('profile:sage:extra:bits')).toBe('sage')
  })

  it('returns undefined for empty profile segment', () => {
    expect(extractProfileName('profile::abc-123')).toBeUndefined()
    expect(extractProfileName('profile:')).toBeUndefined()
  })

  it('returns undefined for keys that look like prefix but use wrong case', () => {
    expect(extractProfileName('PROFILE:sage:abc-123')).toBeUndefined()
    expect(extractProfileName('Profile:sage:abc-123')).toBeUndefined()
  })

  it('returns undefined for non-string inputs', () => {
    expect(extractProfileName(123 as unknown as string)).toBeUndefined()
    expect(extractProfileName({} as unknown as string)).toBeUndefined()
    expect(extractProfileName([] as unknown as string)).toBeUndefined()
  })
})
