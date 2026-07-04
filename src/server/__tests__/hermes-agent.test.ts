import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  resolveHermesAgentDir,
  resolveHermesBinary,
  resolveHermesPython,
  buildHermesPath,
  isHermesAgentHealthy,
  startHermesAgent,
} from '../hermes-agent'

const mockExistsSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  default: { existsSync: mockExistsSync, statSync: vi.fn(), readFileSync: mockReadFileSync },
  existsSync: mockExistsSync,
  statSync: vi.fn(),
  readFileSync: mockReadFileSync,
}))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}))

function createMockChild(pid: number) {
  return {
    pid,
    unref: vi.fn(),
    stdout: { on: vi.fn(), off: vi.fn() },
    stderr: { on: vi.fn(), off: vi.fn() },
  }
}

describe('resolveHermesAgentDir', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.HERMES_AGENT_PATH
  })

  afterEach(() => {
    delete process.env.HERMES_AGENT_PATH
  })

  it('returns HERMES_AGENT_PATH when it contains hermes_cli', () => {
    process.env.HERMES_AGENT_PATH = '/custom/agent'
    mockExistsSync.mockImplementation((p: string) => p === resolve('/custom/agent', 'hermes_cli'))
    expect(resolveHermesAgentDir()).toBe('/custom/agent')
  })

  it('returns null when HERMES_AGENT_PATH is set but missing webapi', () => {
    process.env.HERMES_AGENT_PATH = '/custom/agent'
    mockExistsSync.mockReturnValue(false)
    expect(resolveHermesAgentDir()).toBeNull()
  })

  it('falls back to sibling hermes-agent when hermes_cli exists', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('hermes-agent') && p.endsWith('hermes_cli'),
    )
    const result = resolveHermesAgentDir()
    expect(result).not.toBeNull()
    expect(result).toContain('hermes-agent')
  })

  it('respects env parameter over process.env', () => {
    process.env.HERMES_AGENT_PATH = '/env/agent'
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve('/override/agent', 'hermes_cli'),
    )
    const result = resolveHermesAgentDir({ HERMES_AGENT_PATH: '/override/agent' })
    expect(result).toBe('/override/agent')
  })
})

describe('resolveHermesBinary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns ~/.hermes/bin/hermes when it exists', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve(homedir(), '.hermes', 'bin', 'hermes'),
    )
    expect(resolveHermesBinary()).toBe(resolve(homedir(), '.hermes', 'bin', 'hermes'))
  })

  it('returns ~/.local/bin/hermes as fallback', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve(homedir(), '.local', 'bin', 'hermes'),
    )
    expect(resolveHermesBinary()).toBe(resolve(homedir(), '.local', 'bin', 'hermes'))
  })

  it('returns null when no binary found', () => {
    mockExistsSync.mockReturnValue(false)
    expect(resolveHermesBinary()).toBeNull()
  })
})

describe('resolveHermesPython', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('prefers .venv/bin/python', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve('/agent', '.venv', 'bin', 'python'),
    )
    expect(resolveHermesPython('/agent')).toBe(resolve('/agent', '.venv', 'bin', 'python'))
  })

  it('falls back to venv/bin/python', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve('/agent', 'venv', 'bin', 'python'),
    )
    expect(resolveHermesPython('/agent')).toBe(resolve('/agent', 'venv', 'bin', 'python'))
  })

  it('falls back to ~/.hermes/venv/bin/python', () => {
    mockExistsSync.mockImplementation((p: string) =>
      p === resolve(homedir(), '.hermes', 'venv', 'bin', 'python'),
    )
    expect(resolveHermesPython('/agent')).toBe(resolve(homedir(), '.hermes', 'venv', 'bin', 'python'))
  })

  it('throws when no python interpreter found', () => {
    mockExistsSync.mockReturnValue(false)
    expect(() => resolveHermesPython('/agent')).toThrow('No Hermes Python interpreter found')
  })
})

describe('buildHermesPath', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.PATH
  })

  afterEach(() => {
    delete process.env.PATH
  })

  it('includes hermes bin dirs and agent venv', () => {
    const path = buildHermesPath('/agent')
    expect(path).toContain(resolve(homedir(), '.hermes', 'bin'))
    expect(path).toContain(resolve(homedir(), '.local', 'bin'))
    expect(path).toContain(resolve('/agent', '.venv', 'bin'))
    expect(path).toContain(resolve('/agent', 'venv', 'bin'))
  })

  it('works without agentDir', () => {
    const path = buildHermesPath()
    expect(path).toContain(resolve(homedir(), '.hermes', 'bin'))
    expect(path).toContain(resolve(homedir(), '.local', 'bin'))
    expect(path).not.toContain('.venv')
  })

  it('appends existing PATH', () => {
    process.env.PATH = '/usr/bin'
    const path = buildHermesPath()
    expect(path).toContain('/usr/bin')
  })
})

describe('isHermesAgentHealthy', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns true when health endpoint responds ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response)
    const result = await isHermesAgentHealthy()
    expect(result).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('returns false when health endpoint responds non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)
    const result = await isHermesAgentHealthy()
    expect(result).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await isHermesAgentHealthy()
    expect(result).toBe(false)
  })

  it('uses custom port when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response)
    await isHermesAgentHealthy(9000)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/health',
      expect.anything(),
    )
  })
})

describe('startHermesAgent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    delete process.env.HERMES_HOME
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.HERMES_HOME
  })

  it('returns already running when healthy', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response)
    const result = await startHermesAgent()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toBe('already running')
    }
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns singleton promise for concurrent starts', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockSpawn.mockReturnValue(createMockChild(9999))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)

    const p1 = startHermesAgent()
    const p2 = startHermesAgent()

    // Resolve health on the next poll
    await vi.advanceTimersByTimeAsync(1000)
    ;(globalThis.fetch as any).mockResolvedValue({ ok: true } as Response)
    await vi.advanceTimersByTimeAsync(1000)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('spawns hermes binary when available', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockSpawn.mockReturnValue(createMockChild(9999))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)

    const promise = startHermesAgent()
    await vi.advanceTimersByTimeAsync(11000)
    const result = await promise

    expect(result.ok).toBe(true)
    expect(mockSpawn).toHaveBeenCalledWith(
      resolve(homedir(), '.hermes', 'bin', 'hermes'),
      ['gateway', 'run'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    )
  })

  it('spawns python uvicorn when no binary but agentDir exists', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('hermes-agent') && p.endsWith('hermes_cli')) return true
      if (p.includes('.venv') && p.endsWith('python')) return true
      return false
    })
    mockSpawn.mockReturnValue(createMockChild(9999))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)

    const promise = startHermesAgent()
    await vi.advanceTimersByTimeAsync(11000)
    const result = await promise

    expect(result.ok).toBe(true)
    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[0]).toContain('python')
    expect(spawnCall[1]).toContain('uvicorn')
  })

  it('returns error when neither binary nor agentDir found', async () => {
    mockExistsSync.mockReturnValue(false)

    const result = await startHermesAgent()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('hermes-agent not found')
    }
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns started when health succeeds after polling', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockSpawn.mockReturnValue(createMockChild(12345))
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1
      return Promise.resolve({ ok: callCount >= 2 } as Response)
    })

    const promise = startHermesAgent()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    const result = await promise
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toBe('started')
      expect(result.pid).toBe(12345)
    }
  })

  it('returns starting when health never succeeds within attempts', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockSpawn.mockReturnValue(createMockChild(12345))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)

    const promise = startHermesAgent()
    await vi.advanceTimersByTimeAsync(11000)

    const result = await promise
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.message).toBe('starting')
      expect(result.pid).toBe(12345)
    }
  })

  it('returns error when spawn throws', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockSpawn.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const result = await startHermesAgent()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('ENOENT')
    }
  })

  it('reads ~/.hermes/.env and passes vars to spawned process', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('.hermes') && p.endsWith('bin/hermes')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(
      'CUSTOM_KEY=custom_value\n# comment line\nQUOTED="hello world"\n',
    )
    mockSpawn.mockReturnValue(createMockChild(9999))
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)

    const promise = startHermesAgent()
    await vi.advanceTimersByTimeAsync(11000)
    const result = await promise

    expect(result.ok).toBe(true)
    const [, , options] = mockSpawn.mock.calls[0]
    expect(options.env.CUSTOM_KEY).toBe('custom_value')
    expect(options.env.QUOTED).toBe('hello world')
  })
})
