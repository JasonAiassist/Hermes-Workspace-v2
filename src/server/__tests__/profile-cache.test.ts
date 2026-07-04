import { describe, it, expect, vi } from 'vitest'
import {
  getCachedModel,
  setCachedModel,
  clearProfileModelCache,
} from '../profile-cache'

describe('profile-cache', () => {
  it('returns miss when no entry exists', () => {
    clearProfileModelCache()
    expect(getCachedModel('nonexistent')).toEqual({ hit: false })
  })

  it('caches and retrieves a model', () => {
    clearProfileModelCache()
    setCachedModel('alpha', 'openai/gpt-4')
    expect(getCachedModel('alpha')).toEqual({ hit: true, model: 'openai/gpt-4' })
  })

  it('returns miss after TTL expires', () => {
    vi.useFakeTimers()
    clearProfileModelCache()
    setCachedModel('beta', 'anthropic/claude-3')
    expect(getCachedModel('beta')).toEqual({ hit: true, model: 'anthropic/claude-3' })
    vi.advanceTimersByTime(6_000)
    expect(getCachedModel('beta')).toEqual({ hit: false })
    vi.useRealTimers()
  })

  it('evicts a single profile', () => {
    clearProfileModelCache()
    setCachedModel('gamma', 'x/y')
    setCachedModel('delta', 'a/b')
    clearProfileModelCache('gamma')
    expect(getCachedModel('gamma')).toEqual({ hit: false })
    expect(getCachedModel('delta')).toEqual({ hit: true, model: 'a/b' })
  })

  it('evicts all profiles when called without args', () => {
    clearProfileModelCache()
    setCachedModel('epsilon', 'p/m')
    setCachedModel('zeta', 'q/n')
    clearProfileModelCache()
    expect(getCachedModel('epsilon')).toEqual({ hit: false })
    expect(getCachedModel('zeta')).toEqual({ hit: false })
  })

  it('overwrites existing cache entry', () => {
    clearProfileModelCache()
    setCachedModel('eta', 'old-model')
    setCachedModel('eta', 'new-model')
    expect(getCachedModel('eta')).toEqual({ hit: true, model: 'new-model' })
  })

  it('evicts oldest entry when cache exceeds max size', () => {
    clearProfileModelCache()
    for (let i = 0; i < 101; i++) {
      setCachedModel(`profile-${i}`, `model-${i}`)
    }
    expect(getCachedModel('profile-0')).toEqual({ hit: false })
    expect(getCachedModel('profile-1')).toEqual({ hit: true, model: 'model-1' })
    expect(getCachedModel('profile-100')).toEqual({ hit: true, model: 'model-100' })
  })

  it('distinguishes empty model from cache miss', () => {
    clearProfileModelCache()
    setCachedModel('empty', '')
    expect(getCachedModel('empty')).toEqual({ hit: true, model: '' })
    expect(getCachedModel('never-set')).toEqual({ hit: false })
  })
})