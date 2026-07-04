import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getActiveProfileName,
  clearActiveProfileCache,
} from '../active-profile'

describe('getActiveProfileName', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'active-profile-'))
    vi.stubEnv('HERMES_HOME', tempHome)
    clearActiveProfileCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    clearActiveProfileCache()
    try {
      fs.rmSync(tempHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns "default" when active_profile file does not exist', () => {
    expect(getActiveProfileName()).toBe('default')
  })

  it('reads the active profile from file', () => {
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'coder\n', 'utf-8')
    expect(getActiveProfileName()).toBe('coder')
  })

  it('trims whitespace and lowercases the profile name', () => {
    fs.writeFileSync(
      path.join(tempHome, 'active_profile'),
      '  Sage  \n',
      'utf-8',
    )
    expect(getActiveProfileName()).toBe('sage')
  })

  it('caches the result for repeated calls', () => {
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'coder\n', 'utf-8')
    const first = getActiveProfileName()
    expect(first).toBe('coder')

    // Delete the file — cached value should still be returned
    fs.unlinkSync(path.join(tempHome, 'active_profile'))
    const second = getActiveProfileName()
    expect(second).toBe('coder')
  })

  it('refreshes cache after TTL expires', async () => {
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'coder\n', 'utf-8')
    expect(getActiveProfileName()).toBe('coder')

    // Change the file content
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'sage\n', 'utf-8')

    // Before TTL expires, cache is still valid
    expect(getActiveProfileName()).toBe('coder')

    // Wait for TTL to expire (1s cache)
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(getActiveProfileName()).toBe('sage')
  })

  it('falls back to "default" on read error', () => {
    const activePath = path.join(tempHome, 'active_profile')
    fs.writeFileSync(activePath, 'coder\n', 'utf-8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Make the file unreadable (directory instead of file)
    fs.unlinkSync(activePath)
    fs.mkdirSync(activePath)

    expect(getActiveProfileName()).toBe('default')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read active_profile'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('uses explicit hermesRoot when provided', () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'other-home-'))
    fs.writeFileSync(
      path.join(otherHome, 'active_profile'),
      'other-profile\n',
      'utf-8',
    )

    expect(getActiveProfileName(otherHome)).toBe('other-profile')

    // Should not pollute the default HERMES_HOME cache
    expect(getActiveProfileName()).toBe('default')

    fs.rmSync(otherHome, { recursive: true, force: true })
  })

  it('caches per-hermesRoot independently', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'root-a-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'root-b-'))

    fs.writeFileSync(path.join(rootA, 'active_profile'), 'profile-a\n', 'utf-8')
    fs.writeFileSync(path.join(rootB, 'active_profile'), 'profile-b\n', 'utf-8')

    expect(getActiveProfileName(rootA)).toBe('profile-a')
    expect(getActiveProfileName(rootB)).toBe('profile-b')
    // Second call should use cache
    expect(getActiveProfileName(rootA)).toBe('profile-a')
    expect(getActiveProfileName(rootB)).toBe('profile-b')

    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
  })
})

describe('clearActiveProfileCache', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'active-profile-clear-'))
    vi.stubEnv('HERMES_HOME', tempHome)
    clearActiveProfileCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    clearActiveProfileCache()
    try {
      fs.rmSync(tempHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('clears the entire cache when called with no args', () => {
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'coder\n', 'utf-8')
    expect(getActiveProfileName()).toBe('coder')

    clearActiveProfileCache()
    fs.unlinkSync(path.join(tempHome, 'active_profile'))
    // After cache clear, should re-read from disk
    expect(getActiveProfileName()).toBe('default')
  })

  it('clears only the specified root when called with hermesRoot', () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'other-clear-'))
    fs.writeFileSync(
      path.join(otherHome, 'active_profile'),
      'other-profile\n',
      'utf-8',
    )
    fs.writeFileSync(path.join(tempHome, 'active_profile'), 'local\n', 'utf-8')

    expect(getActiveProfileName(otherHome)).toBe('other-profile')
    expect(getActiveProfileName()).toBe('local')

    clearActiveProfileCache(otherHome)
    fs.unlinkSync(path.join(otherHome, 'active_profile'))

    // otherHome cache was cleared, so it re-reads
    expect(getActiveProfileName(otherHome)).toBe('default')
    // local cache is still valid
    expect(getActiveProfileName()).toBe('local')

    fs.rmSync(otherHome, { recursive: true, force: true })
  })
})
