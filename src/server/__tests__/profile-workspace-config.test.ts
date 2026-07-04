import { describe, it, expect, vi, beforeEach } from 'vitest'

const { existsSync, readFileSync } = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
}))

vi.mock('node:fs', () => ({
  default: { existsSync, readFileSync },
  existsSync,
  readFileSync,
}))

vi.mock('../hermes-home', () => ({
  getHermesHome: () => '/home/testuser/.hermes',
  getProfilesRoot: () => '/home/testuser/.hermes/profiles',
}))

const mockReadYamlConfig = vi.fn().mockReturnValue({})

vi.mock('../config-reader', () => ({
  readYamlConfig: (...args: unknown[]) => mockReadYamlConfig(...args),
}))

async function loadMod() {
  return await import('../profile-workspace-config')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getProfileWorkspaceConfig', () => {
  it('returns persistent=false for missing config file', async () => {
    existsSync.mockReturnValue(false)
    const mod = await loadMod()
    const result = mod.getProfileWorkspaceConfig('test')

    expect(result.persistent).toBe(false)
    expect(result.allocatedTo).toBeUndefined()
  })

  it('reads persistent=true from config', async () => {
    existsSync.mockReturnValue(true)
    mockReadYamlConfig.mockReturnValue({
      workspace: {
        persistence: {
          persistent: true,
        },
      },
    })

    const mod = await loadMod()
    const result = mod.getProfileWorkspaceConfig('test')

    expect(result.persistent).toBe(true)
    expect(result.allocatedTo).toBeUndefined()
  })

  it('reads allocatedTo from config', async () => {
    existsSync.mockReturnValue(true)
    mockReadYamlConfig.mockReturnValue({
      workspace: {
        persistence: {
          persistent: false,
          allocatedTo: 'sage',
        },
      },
    })

    const mod = await loadMod()
    const result = mod.getProfileWorkspaceConfig('test')

    expect(result.persistent).toBe(false)
    expect(result.allocatedTo).toBe('sage')
  })

  it('returns defaults for malformed config', async () => {
    existsSync.mockReturnValue(true)
    mockReadYamlConfig.mockImplementation(() => {
      throw new Error('parse error')
    })

    const mod = await loadMod()
    const result = mod.getProfileWorkspaceConfig('test')

    expect(result.persistent).toBe(false)
  })
})
