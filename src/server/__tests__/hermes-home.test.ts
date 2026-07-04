import { describe, it, expect } from 'vitest'
import { getHermesHome } from '../hermes-home'

describe('getHermesHome', () => {
  it('returns HERMES_HOME env var when set', () => {
    const original = process.env.HERMES_HOME
    process.env.HERMES_HOME = '/custom/hermes/path'
    try {
      expect(getHermesHome()).toBe('/custom/hermes/path')
    } finally {
      if (original === undefined) {
        delete process.env.HERMES_HOME
      } else {
        process.env.HERMES_HOME = original
      }
    }
  })

  it('falls back to ~/.hermes when env var is unset', () => {
    const original = process.env.HERMES_HOME
    delete process.env.HERMES_HOME
    try {
      const result = getHermesHome()
      expect(result).toMatch(/\.hermes$/)
      expect(result).not.toContain('HERMES_HOME')
    } finally {
      if (original !== undefined) {
        process.env.HERMES_HOME = original
      }
    }
  })
})

import { getProfilesRoot } from '../hermes-home'

describe('getProfilesRoot', () => {
  it('returns <hermes-home>/profiles path', () => {
    const original = process.env.HERMES_HOME
    process.env.HERMES_HOME = '/custom/hermes'
    try {
      const result = getProfilesRoot()
      expect(result).toBe('/custom/hermes/profiles')
    } finally {
      if (original === undefined) {
        delete process.env.HERMES_HOME
      } else {
        process.env.HERMES_HOME = original
      }
    }
  })

  it('appends /profiles to default home when env var unset', () => {
    const original = process.env.HERMES_HOME
    delete process.env.HERMES_HOME
    try {
      const result = getProfilesRoot()
      expect(result).toMatch(/\.hermes\/profiles$/)
    } finally {
      if (original !== undefined) {
        process.env.HERMES_HOME = original
      }
    }
  })
})

import { DEFAULT_CACHE_TTL_MS } from '../constants'

describe('constants', () => {
  it('exposes DEFAULT_CACHE_TTL_MS as 5 seconds', () => {
    expect(DEFAULT_CACHE_TTL_MS).toBe(5_000)
  })
})