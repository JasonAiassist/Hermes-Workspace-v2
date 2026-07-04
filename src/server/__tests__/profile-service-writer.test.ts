import { describe, it, expect, vi, beforeEach } from 'vitest'

const { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn().mockImplementation(() => {}),
  writeFileSync: vi.fn().mockImplementation(() => {}),
  unlinkSync: vi.fn().mockImplementation(() => {}),
  readFileSync: vi.fn().mockImplementation(() => ''),
}))

vi.mock('node:fs', () => ({
  default: { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync },
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
}))

const { homedir } = vi.hoisted(() => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}))

vi.mock('node:os', () => ({
  default: { homedir },
  homedir,
}))

const mockResolveHermesBinary = vi.fn().mockReturnValue('/home/testuser/.local/bin/hermes')
const mockGetProfileHermesHome = vi.fn().mockReturnValue('/home/testuser/.hermes/profiles/test-profile')

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('../hermes-agent', () => ({
  resolveHermesBinary: () => mockResolveHermesBinary(),
}))

vi.mock('../gateway-registry', () => ({
  getProfileHermesHome: (...args: unknown[]) => mockGetProfileHermesHome(...args),
}))

async function loadMod() {
  return await import('../profile-service-writer')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('writeProfileSystemdService', () => {
  it('writes a systemd service file matching the canonical SAGE template', async () => {
    const envPath = '/home/testuser/.hermes/profiles/test-profile/.env'
    existsSync.mockImplementation((p: string) => p === envPath)
    readFileSync.mockImplementation((p: string) => {
      if (p === envPath) return 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=abc123\nAPI_SERVER_PORT=8642\n'
      return ''
    })

    const mod = await loadMod()
    const result = mod.writeProfileSystemdService('test-profile')

    expect(result.success).toBe(true)
    expect(writeFileSync).toHaveBeenCalled()

    const [servicePath, content] = writeFileSync.mock.calls[0] as [string, string]
    expect(servicePath).toBe('/home/testuser/.config/systemd/user/hermes-gateway-test-profile.service')
    expect(content).toContain('Description=Hermes test-profile Gateway')
    expect(content).toContain('After=network.target')
    expect(content).toContain('Environment=HERMES_HOME=/home/testuser/.hermes/profiles/test-profile')
    expect(content).toContain('Environment=API_SERVER_ENABLED=true')
    expect(content).toContain('Environment=API_SERVER_PORT=8642')
    expect(content).toContain('ExecStart=/home/testuser/.local/bin/hermes gateway run --replace')
    expect(content).toContain('Restart=on-failure')
    expect(content).toContain('RestartSec=5')
    expect(content).toContain('WorkingDirectory=/home/testuser/.hermes/profiles/test-profile')
    expect(content).toContain('EnvironmentFile=-/home/testuser/.hermes/profiles/test-profile/.env')
    expect(content).not.toContain('--profile')
  })

  it('triggers systemctl daemon-reload after writing the service file', async () => {
    const envPath = '/home/testuser/.hermes/profiles/test-profile/.env'
    existsSync.mockImplementation((p: string) => p === envPath)
    readFileSync.mockImplementation((p: string) => {
      if (p === envPath) return 'API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8642\n'
      return ''
    })
    const { execSync } = await import('node:child_process')
    const mod = await loadMod()
    mod.writeProfileSystemdService('test-profile')
    expect(execSync).toHaveBeenCalledWith(
      'systemctl --user daemon-reload',
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('survives daemon-reload failure (returns success=true, no error)', async () => {
    const envPath = '/home/testuser/.hermes/profiles/test-profile/.env'
    existsSync.mockImplementation((p: string) => p === envPath)
    readFileSync.mockImplementation((p: string) => {
      if (p === envPath) return 'API_SERVER_PORT=8642\n'
      return ''
    })
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('systemctl not found')
    })
    const mod = await loadMod()
    const result = mod.writeProfileSystemdService('test-profile')
    // Daemon-reload failure is best-effort — write still succeeds
    expect(result.success).toBe(true)
    expect(writeFileSync).toHaveBeenCalled()
    vi.mocked(execSync).mockReset()
  })

  it('fails gracefully when hermes binary is not found', async () => {
    mockResolveHermesBinary.mockReturnValueOnce(null)
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('API_SERVER_PORT=8642\n')
    const mod = await loadMod()
    const result = mod.writeProfileSystemdService('test-profile')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('not found')
    }
  })

  it('fails gracefully when profile .env is missing', async () => {
    existsSync.mockReturnValue(false)
    const mod = await loadMod()
    const result = mod.writeProfileSystemdService('test-profile')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('.env not found')
    }
  })

  it('fails gracefully when API_SERVER_PORT is missing from .env', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('API_SERVER_ENABLED=true\nAPI_SERVER_KEY=abc123\n')
    const mod = await loadMod()
    const result = mod.writeProfileSystemdService('test-profile')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('API_SERVER_PORT')
    }
  })
})

describe('removeProfileSystemdService', () => {
  it('removes the service file if it exists', async () => {
    existsSync.mockReturnValue(true)
    const mod = await loadMod()
    mod.removeProfileSystemdService('test-profile')

    expect(unlinkSync).toHaveBeenCalledWith(
      '/home/testuser/.config/systemd/user/hermes-gateway-test-profile.service',
    )
  })

  it('does nothing if the service file does not exist', async () => {
    existsSync.mockReturnValue(false)
    const mod = await loadMod()
    mod.removeProfileSystemdService('test-profile')

    expect(unlinkSync).not.toHaveBeenCalled()
  })
})

describe('hasSystemdService', () => {
  it('returns true when service file exists', async () => {
    existsSync.mockReturnValue(true)
    const mod = await loadMod()
    expect(mod.hasSystemdService('test-profile')).toBe(true)
  })

  it('returns false when service file does not exist', async () => {
    existsSync.mockReturnValue(false)
    const mod = await loadMod()
    expect(mod.hasSystemdService('test-profile')).toBe(false)
  })
})
