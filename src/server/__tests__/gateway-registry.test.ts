import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readGatewayRegistry,
  writeGatewayRegistry,
  getRegistryEntry,
  removeRegistryEntry,
  setRegistryEntry,
  reconcileRegistry,
  isProcessAlive,
  initializeGatewayRegistry,
} from '../gateway-registry'
import type { GatewayRegistry, GatewayRegistryEntry } from '../gateway-registry'

describe('gateway-registry', () => {
  let tempDir: string
  let originalHome: string | undefined
  let originalHermesHome: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gw-reg-test-'))
    originalHome = process.env.HOME
    originalHermesHome = process.env.HERMES_HOME
    process.env.HOME = tempDir
    delete process.env.HERMES_HOME
  })

  afterEach(() => {
    process.env.HOME = originalHome
    if (originalHermesHome !== undefined) {
      process.env.HERMES_HOME = originalHermesHome
    } else {
      delete process.env.HERMES_HOME
    }
    const registryPath = join(tempDir, '.hermes', 'gateway-registry.json')
    try {
      if (existsSync(registryPath)) unlinkSync(registryPath)
    } catch { /* ignore */ }
  })

  function writeRaw(content: string) {
    const dir = join(tempDir, '.hermes')
    const filePath = join(dir, 'gateway-registry.json')
    // Ensure directory exists
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    writeFileSync(filePath, content, 'utf-8')
  }

  function makeEntry(overrides?: Partial<GatewayRegistryEntry>): GatewayRegistryEntry {
    return {
      httpPort: 8643,
      wsPort: 18790,
      pid: 1234,
      startedAt: 1700000000000,
      ...overrides,
    }
  }

  describe('readGatewayRegistry', () => {
    it('returns empty registry when file does not exist', () => {
      const reg = readGatewayRegistry()
      expect(reg.version).toBe(1)
      expect(Object.keys(reg.entries)).toHaveLength(0)
    })

    it('returns parsed registry when file exists', () => {
      const entry = makeEntry()
      writeRaw(JSON.stringify({
        version: 1,
        entries: {
          sage: entry,
        },
      }))

      const reg = readGatewayRegistry()
      expect(reg.entries.sage).toEqual(entry)
    })

    it('returns empty registry when JSON is invalid', () => {
      writeRaw('not-json{{')
      const reg = readGatewayRegistry()
      expect(Object.keys(reg.entries)).toHaveLength(0)
    })

    it('returns empty registry when data lacks version or entries', () => {
      writeRaw(JSON.stringify(['array']))
      const reg = readGatewayRegistry()
      expect(Object.keys(reg.entries)).toHaveLength(0)
    })
  })

  describe('writeGatewayRegistry', () => {
    it('writes valid registry to file', () => {
      const entry = makeEntry()
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          sage: entry,
        },
      }
      writeGatewayRegistry(reg)

      const raw = readFileSync(join(tempDir, '.hermes', 'gateway-registry.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.entries.sage).toEqual(entry)
    })

    it('overwrites existing file', () => {
      writeRaw(JSON.stringify({
        version: 1,
        entries: { old: makeEntry({ httpPort: 1 }) },
      }))
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          new: makeEntry(),
        },
      }
      writeGatewayRegistry(reg)

      const parsed = JSON.parse(readFileSync(join(tempDir, '.hermes', 'gateway-registry.json'), 'utf-8'))
      expect(parsed.entries.new).toBeDefined()
      expect(parsed.entries.old).toBeUndefined()
    })
  })

  describe('getRegistryEntry', () => {
    it('returns entry when it exists', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: { sage: makeEntry() },
      }
      const entry = getRegistryEntry(reg, 'sage')
      expect(entry).toEqual(makeEntry())
    })

    it('returns undefined when entry does not exist', () => {
      const reg: GatewayRegistry = { version: 1, entries: {} }
      const entry = getRegistryEntry(reg, 'sage')
      expect(entry).toBeUndefined()
    })
  })

  describe('setRegistryEntry', () => {
    it('adds entry to registry', () => {
      const reg: GatewayRegistry = { version: 1, entries: {} }
      const entry = makeEntry()
      setRegistryEntry(reg, 'sage', entry)
      expect(reg.entries.sage).toEqual(entry)
    })

    it('overwrites existing entry', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: { sage: makeEntry({ httpPort: 1111 }) },
      }
      setRegistryEntry(reg, 'sage', makeEntry({ httpPort: 8643 }))
      expect(reg.entries.sage.httpPort).toBe(8643)
    })
  })

  describe('removeRegistryEntry', () => {
    it('removes the specified entry', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          sage: makeEntry(),
          jarvis: makeEntry({ httpPort: 8644 }),
        },
      }
      removeRegistryEntry(reg, 'sage')
      expect(reg.entries.jarvis).toBeDefined()
      expect(reg.entries.sage).toBeUndefined()
    })

    it('does nothing when entry does not exist', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: { jarvis: makeEntry() },
      }
      removeRegistryEntry(reg, 'sage')
      expect(reg.entries.jarvis).toBeDefined()
    })
  })

  describe('isProcessAlive', () => {
    it('returns true for current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true)
    })

    it('returns false for non-existent PID', () => {
      expect(isProcessAlive(999999)).toBe(false)
    })
  })

  describe('reconcileRegistry', () => {
    it('keeps entries with alive PIDs', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          current: makeEntry({ pid: process.pid }),
        },
      }
      const cleaned = reconcileRegistry(reg)
      expect(cleaned.entries.current).toBeDefined()
    })

    it('removes entries with dead PIDs', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          dead: makeEntry({ pid: 999999 }),
        },
      }
      const cleaned = reconcileRegistry(reg)
      expect(Object.keys(cleaned.entries)).toHaveLength(0)
    })

    it('returns a new registry object', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: { dead: makeEntry({ pid: 999999 }) },
      }
      const cleaned = reconcileRegistry(reg)
      expect(cleaned).not.toBe(reg)
      // Original is not mutated
      expect(reg.entries.dead).toBeDefined()
    })
  })

  describe('initializeGatewayRegistry', () => {
    it('reconciles and writes when stale entries exist', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          alive: makeEntry({ pid: process.pid }),
          dead: makeEntry({ pid: 999999 }),
        },
      }
      writeGatewayRegistry(reg)

      initializeGatewayRegistry()

      const after = readGatewayRegistry()
      expect(after.entries.alive).toBeDefined()
      expect(after.entries.dead).toBeUndefined()
    })

    it('does nothing when all PIDs are alive', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          alive: makeEntry({ pid: process.pid }),
        },
      }
      writeGatewayRegistry(reg)

      initializeGatewayRegistry()

      const after = readGatewayRegistry()
      expect(after.entries.alive).toBeDefined()
      expect(Object.keys(after.entries)).toHaveLength(1)
    })

    it('handles missing registry file gracefully', () => {
      // Ensure file does not exist
      const registryPath = join(tempDir, '.hermes', 'gateway-registry.json')
      try {
        if (existsSync(registryPath)) unlinkSync(registryPath)
      } catch { /* ignore */ }

      // Should not throw
      expect(() => initializeGatewayRegistry()).not.toThrow()

      const after = readGatewayRegistry()
      expect(after.version).toBe(1)
      expect(Object.keys(after.entries)).toHaveLength(0)
    })

    it('is idempotent (calling twice produces same result)', () => {
      const reg: GatewayRegistry = {
        version: 1,
        entries: {
          alive: makeEntry({ pid: process.pid }),
          dead: makeEntry({ pid: 999999 }),
        },
      }
      writeGatewayRegistry(reg)

      initializeGatewayRegistry()
      const first = readGatewayRegistry()
      initializeGatewayRegistry()
      const second = readGatewayRegistry()

      expect(first).toEqual(second)
    })
  })
})
