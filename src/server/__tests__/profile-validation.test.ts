import { describe, it, expect } from 'vitest'
import { validateProfileName, isValidProfileName } from '../profile-validation'

describe('validateProfileName', () => {
  it('accepts valid names', () => {
    const cases = ['sage', 'jarvis', 'agent_01', 'my-profile', 'A1']
    for (const name of cases) {
      const result = validateProfileName(name)
      expect(result.valid).toBe(true)
      expect((result as { valid: true; name: string }).name).toBe(name)
    }
  })

  it('rejects empty input', () => {
    const result = validateProfileName('')
    expect(result.valid).toBe(false)
    expect((result as { valid: false; error: string }).error).toBe('Profile name is required')
  })

  it('rejects non-string input', () => {
    const result = validateProfileName(null)
    expect(result.valid).toBe(false)
  })

  it('rejects names with invalid characters', () => {
    const result = validateProfileName('sage!')
    expect(result.valid).toBe(false)
    expect((result as { valid: false; error: string }).error).toBe('Invalid profile name')
  })

  it('rejects names starting with underscore', () => {
    const result = validateProfileName('_sage')
    expect(result.valid).toBe(false)
  })

  it('rejects names longer than 64 characters', () => {
    const result = validateProfileName('a'.repeat(65))
    expect(result.valid).toBe(false)
  })

  it('rejects "default" as a reserved name', () => {
    const result = validateProfileName('default')
    expect(result.valid).toBe(false)
    expect((result as { valid: false; error: string }).error).toContain('reserved')
  })

  it('rejects "DEFAULT" case-insensitively', () => {
    const result = validateProfileName('DEFAULT')
    expect(result.valid).toBe(false)
    expect((result as { valid: false; error: string }).error).toContain('reserved')
  })

  it('accepts "default" when allowDefault is true', () => {
    const result = validateProfileName('default', true)
    expect(result.valid).toBe(true)
    expect((result as { valid: true; name: string }).name).toBe('default')
  })

  it('accepts "DEFAULT" when allowDefault is true', () => {
    const result = validateProfileName('DEFAULT', true)
    expect(result.valid).toBe(true)
    expect((result as { valid: true; name: string }).name).toBe('DEFAULT')
  })
})

describe('isValidProfileName', () => {
  it('accepts valid names', () => {
    const cases = ['sage', 'jarvis', 'agent_01', 'my-profile', 'A1']
    for (const name of cases) {
      expect(isValidProfileName(name)).toBe(true)
    }
  })

  it('rejects empty input', () => {
    expect(isValidProfileName('')).toBe(false)
  })

  it('rejects whitespace-only input', () => {
    expect(isValidProfileName('   ')).toBe(false)
  })

  it('rejects names with invalid characters', () => {
    expect(isValidProfileName('sage!')).toBe(false)
  })

  it('rejects names starting with underscore', () => {
    expect(isValidProfileName('_sage')).toBe(false)
  })

  it('rejects names longer than 64 characters', () => {
    expect(isValidProfileName('a'.repeat(65))).toBe(false)
  })

  it('rejects "default" as a reserved name', () => {
    expect(isValidProfileName('default')).toBe(false)
  })

  it('rejects "DEFAULT" case-insensitively', () => {
    expect(isValidProfileName('DEFAULT')).toBe(false)
  })

  it('accepts "default" when allowDefault is true', () => {
    expect(isValidProfileName('default', true)).toBe(true)
  })

  it('accepts "DEFAULT" when allowDefault is true', () => {
    expect(isValidProfileName('DEFAULT', true)).toBe(true)
  })

  it('accepts valid names after trimming', () => {
    expect(isValidProfileName('  sage  ')).toBe(true)
  })
})