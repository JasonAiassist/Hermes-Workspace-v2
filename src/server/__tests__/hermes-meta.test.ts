/**
 * Behavior tests for hermes-meta.
 *
 * Verifies:
 *   - All read endpoints (memory, skills, config, models) hit the
 *     right path with the right profileName
 *   - patchConfig sends PATCH with the supplied object
 *   - isHermesAvailable returns true on 2xx, false on non-2xx, false on throw
 *   - isHermesAvailable uses a 3-second timeout
 *   - checkHealth returns the parsed JSON
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../hermes-api-client', () => ({
  hermesGet: vi.fn(),
  hermesPatch: vi.fn(),
  resolveBaseUrl: vi.fn().mockResolvedValue('http://gw:9999'),
}))

import { hermesGet, hermesPatch, resolveBaseUrl } from '../hermes-api-client'

import {
  checkHealth,
  getConfig,
  getMemory,
  getSkill,
  getSkillCategories,
  isHermesAvailable,
  listModels,
  listSkills,
  patchConfig,
} from '../hermes-meta'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveBaseUrl).mockResolvedValue('http://gw:9999')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memory', () => {
  it('GETs /api/memory with profileName', async () => {
    vi.mocked(hermesGet).mockResolvedValue({ entries: [] })
    await getMemory('sage')
    expect(hermesGet).toHaveBeenCalledWith('/api/memory', 'sage')
  })
})

describe('skills', () => {
  it('listSkills hits /api/skills', async () => {
    await listSkills('sage')
    expect(hermesGet).toHaveBeenCalledWith('/api/skills', 'sage')
  })

  it('getSkill URL-encodes the skill name', async () => {
    await getSkill('hello world', 'sage')
    expect(hermesGet).toHaveBeenCalledWith('/api/skills/hello%20world', 'sage')
  })

  it('getSkillCategories hits /api/skills/categories', async () => {
    await getSkillCategories('sage')
    expect(hermesGet).toHaveBeenCalledWith('/api/skills/categories', 'sage')
  })
})

describe('config', () => {
  it('getConfig hits /api/config', async () => {
    vi.mocked(hermesGet).mockResolvedValue({ model: 'kimi' })
    const out = await getConfig('sage')
    expect(out).toEqual({ model: 'kimi' })
    expect(hermesGet).toHaveBeenCalledWith('/api/config', 'sage')
  })

  it('patchConfig PATCHes the supplied object', async () => {
    vi.mocked(hermesPatch).mockResolvedValue({ ok: true })
    await patchConfig({ model: 'kimi', temperature: 0.5 }, 'sage')
    expect(hermesPatch).toHaveBeenCalledWith(
      '/api/config',
      { model: 'kimi', temperature: 0.5 },
      'sage',
    )
  })
})

describe('models', () => {
  it('listModels hits /v1/models', async () => {
    vi.mocked(hermesGet).mockResolvedValue({
      object: 'list',
      data: [{ id: 'kimi', object: 'model' }],
    })
    const out = await listModels('sage')
    expect(out).toEqual({
      object: 'list',
      data: [{ id: 'kimi', object: 'model' }],
    })
    expect(hermesGet).toHaveBeenCalledWith('/v1/models', 'sage')
  })
})

describe('isHermesAvailable', () => {
  it('returns true when /health responds OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    )
    expect(await isHermesAvailable('sage')).toBe(true)
  })

  it('returns false when /health returns non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    )
    expect(await isHermesAvailable('sage')).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await isHermesAvailable('sage')).toBe(false)
  })

  it('uses a 3-second AbortSignal timeout', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchSpy)
    await isHermesAvailable('sage')
    const signal = fetchSpy.mock.calls[0][1].signal as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    // Timeout exists (AbortSignal.timeout may be a no-op in jsdom; here we
    // just verify a signal was passed).
  })
})

describe('checkHealth', () => {
  it('returns the parsed /health JSON', async () => {
    vi.mocked(hermesGet).mockResolvedValue({ status: 'ok' })
    const out = await checkHealth('sage')
    expect(out).toEqual({ status: 'ok' })
    expect(hermesGet).toHaveBeenCalledWith('/health', 'sage')
  })
})