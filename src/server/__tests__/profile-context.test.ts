import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  profileContextStorage,
  withActiveProfile,
  getActiveProfileContext,
  withProfileContext,
} from '../profile-context'

const mockGetActiveProfileName = vi.hoisted(() => vi.fn().mockReturnValue('sage'))

vi.mock('../active-profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
}))

describe('profile-context AsyncLocalStorage', () => {
  beforeEach(() => {
    mockGetActiveProfileName.mockReturnValue('sage')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined when no profile context is set', () => {
    expect(getActiveProfileContext()).toBeUndefined()
  })

  it('withActiveProfile sets context for the duration of fn', async () => {
    await withActiveProfile('sage', async () => {
      expect(getActiveProfileContext()).toBe('sage')
    })
    expect(getActiveProfileContext()).toBeUndefined()
  })

  it('preserves context across await boundaries', async () => {
    await withActiveProfile('jarvis', async () => {
      await new Promise((r) => setTimeout(r, 10))
      expect(getActiveProfileContext()).toBe('jarvis')
      await new Promise((r) => setTimeout(r, 10))
      expect(getActiveProfileContext()).toBe('jarvis')
    })
  })

  it('nested withActiveProfile calls restore outer context', async () => {
    await withActiveProfile('outer', async () => {
      expect(getActiveProfileContext()).toBe('outer')
      await withActiveProfile('inner', async () => {
        expect(getActiveProfileContext()).toBe('inner')
      })
      expect(getActiveProfileContext()).toBe('outer')
    })
  })

  it('returns the value from fn when context exits', async () => {
    const result = await withActiveProfile('sage', async () => {
      return 42
    })
    expect(result).toBe(42)
  })

  it('propagates errors from fn but still clears context', async () => {
    await expect(
      withActiveProfile('sage', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(getActiveProfileContext()).toBeUndefined()
  })
})

describe('withProfileContext (HTTP route wrapper)', () => {
  beforeEach(() => {
    mockGetActiveProfileName.mockReturnValue('default-profile')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses X-Hermes-Profile header when present (overrides active)', async () => {
    const request = new Request('http://localhost/', {
      headers: { 'X-Hermes-Profile': 'override-profile' },
    })
    await withProfileContext(request, async () => {
      expect(getActiveProfileContext()).toBe('override-profile')
    })
    expect(mockGetActiveProfileName).not.toHaveBeenCalled()
  })

  it('falls back to active profile when header is absent', async () => {
    const request = new Request('http://localhost/', {})
    await withProfileContext(request, async () => {
      expect(getActiveProfileContext()).toBe('default-profile')
    })
    expect(mockGetActiveProfileName).toHaveBeenCalled()
  })

  it('falls back to active profile when header is whitespace only', async () => {
    const request = new Request('http://localhost/', {
      headers: { 'X-Hermes-Profile': '   ' },
    })
    await withProfileContext(request, async () => {
      expect(getActiveProfileContext()).toBe('default-profile')
    })
  })

  it('passes hermesRoot through to getActiveProfileName', async () => {
    const request = new Request('http://localhost/', {})
    await withProfileContext(request, async () => {
      // noop
    }, '/custom/hermes')
    expect(mockGetActiveProfileName).toHaveBeenCalledWith('/custom/hermes')
  })
})

describe('profileContextStorage module export', () => {
  it('is an AsyncLocalStorage instance', () => {
    expect(profileContextStorage).toBeDefined()
    expect(typeof profileContextStorage.getStore).toBe('function')
    expect(typeof profileContextStorage.run).toBe('function')
  })
})