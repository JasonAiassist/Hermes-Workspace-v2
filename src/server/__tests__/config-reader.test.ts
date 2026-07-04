import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  readYamlConfig,
  writeFileAtomic,
  writeYamlConfig,
  cleanupStaleTempFiles,
  setConfigReaderLogger,
} from '../config-reader'

describe('config-reader', () => {
  let tmpDir: string
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.HERMES_HOME
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-reader-test-'))
    process.env.HERMES_HOME = tmpDir
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = originalEnv
    }
    try {
      fs.rmSync(tmpDir, { recursive: true })
    } catch {
      /* ignore */
    }
  })

  describe('readYamlConfig', () => {
    it('returns empty object when file is missing', () => {
      const result = readYamlConfig(path.join(tmpDir, 'missing.yaml'))
      expect(result).toEqual({})
    })

    it('parses valid YAML', () => {
      const filePath = path.join(tmpDir, 'valid.yaml')
      fs.writeFileSync(filePath, 'model: openai/gpt-4\nprovider: openai\n', 'utf-8')
      const result = readYamlConfig(filePath)
      expect(result).toEqual({ model: 'openai/gpt-4', provider: 'openai' })
    })

    it('returns empty object and warns on invalid YAML', () => {
      const filePath = path.join(tmpDir, 'invalid.yaml')
      fs.writeFileSync(filePath, '{ bad yaml: [', 'utf-8')
      const warnSpy = vi.fn()
      setConfigReaderLogger({ warn: warnSpy })
      const result = readYamlConfig(filePath)
      expect(result).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
      setConfigReaderLogger(console)
    })

    it('returns empty object and warns when YAML parses to non-object (array)', () => {
      const filePath = path.join(tmpDir, 'array.yaml')
      fs.writeFileSync(filePath, '- item1\n- item2\n', 'utf-8')
      const warnSpy = vi.fn()
      setConfigReaderLogger({ warn: warnSpy })
      const result = readYamlConfig(filePath)
      expect(result).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
      expect(warnSpy.mock.calls[0][0]).toContain('not an object')
      setConfigReaderLogger(console)
    })

    it('returns empty object and warns when YAML parses to scalar', () => {
      const filePath = path.join(tmpDir, 'scalar.yaml')
      fs.writeFileSync(filePath, 'just-a-string\n', 'utf-8')
      const warnSpy = vi.fn()
      setConfigReaderLogger({ warn: warnSpy })
      const result = readYamlConfig(filePath)
      expect(result).toEqual({})
      expect(warnSpy).toHaveBeenCalled()
      setConfigReaderLogger(console)
    })
  })

  describe('writeFileAtomic', () => {
    it('writes content to a file atomically', () => {
      const filePath = path.join(tmpDir, 'output.txt')
      writeFileAtomic(filePath, 'hello world')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world')
    })

    it('creates parent directories if missing', () => {
      const filePath = path.join(tmpDir, 'nested', 'deep', 'file.txt')
      writeFileAtomic(filePath, 'deep content')
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep content')
    })

    it('falls back to copy+unlink on EXDEV', () => {
      const renameSyncSpy = vi
        .spyOn(fs, 'renameSync')
        .mockImplementation(() => {
          const err = new Error('Cross-device link not permitted') as NodeJS.ErrnoException
          err.code = 'EXDEV'
          throw err
        })
      const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {})
      const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})

      const filePath = path.join(tmpDir, 'exdev-target.txt')
      writeFileAtomic(filePath, 'exdev content')

      expect(copyFileSyncSpy).toHaveBeenCalled()
      expect(unlinkSyncSpy).toHaveBeenCalled()

      renameSyncSpy.mockRestore()
      copyFileSyncSpy.mockRestore()
      unlinkSyncSpy.mockRestore()
    })

    it('rethrows the COPY error when EXDEV fallback copy fails', () => {
      const renameSyncSpy = vi
        .spyOn(fs, 'renameSync')
        .mockImplementation(() => {
          const err = new Error('Cross-device link not permitted') as NodeJS.ErrnoException
          err.code = 'EXDEV'
          throw err
        })
      const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        const err = new Error('No space left on device') as NodeJS.ErrnoException
        err.code = 'ENOSPC'
        throw err
      })
      const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})

      const filePath = path.join(tmpDir, 'exdev-copy-fail.txt')
      expect(() => writeFileAtomic(filePath, 'exdev content')).toThrow('No space left on device')
      expect(copyFileSyncSpy).toHaveBeenCalled()
      expect(unlinkSyncSpy).toHaveBeenCalled()

      renameSyncSpy.mockRestore()
      copyFileSyncSpy.mockRestore()
      unlinkSyncSpy.mockRestore()
    })

    it('rethrows non-EXDEV errors and cleans up temp file', () => {
      const renameSyncSpy = vi
        .spyOn(fs, 'renameSync')
        .mockImplementation(() => {
          const err = new Error('Permission denied') as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        })
      const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})

      const filePath = path.join(tmpDir, 'fail-target.txt')
      expect(() => writeFileAtomic(filePath, 'fail content')).toThrow('Permission denied')
      expect(unlinkSyncSpy).toHaveBeenCalled()

      renameSyncSpy.mockRestore()
      unlinkSyncSpy.mockRestore()
    })
  })

  describe('writeYamlConfig', () => {
    it('writes object as YAML', () => {
      const filePath = path.join(tmpDir, 'config.yaml')
      writeYamlConfig(filePath, { model: 'gpt-4', provider: 'openai' })
      const raw = fs.readFileSync(filePath, 'utf-8')
      expect(raw).toContain('model: gpt-4')
      expect(raw).toContain('provider: openai')
    })
  })

  describe('cleanupStaleTempFiles', () => {
    it('removes temp files older than 1 hour', () => {
      const now = Date.now()
      const oldFile = path.join(tmpDir, 'stale.tmp.old')
      const recentFile = path.join(tmpDir, 'fresh.tmp.recent')
      fs.writeFileSync(oldFile, 'old', 'utf-8')
      fs.writeFileSync(recentFile, 'recent', 'utf-8')

      const statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation((p) => {
        if (p === oldFile) {
          return { mtimeMs: now - 3_600_001 } as fs.Stats
        }
        if (p === recentFile) {
          return { mtimeMs: now - 100 } as fs.Stats
        }
        return fs.statSync(p)
      })

      cleanupStaleTempFiles(tmpDir)

      expect(fs.existsSync(oldFile)).toBe(false)
      expect(fs.existsSync(recentFile)).toBe(true)

      statSyncSpy.mockRestore()
    })

    it('returns early when base dir does not exist', () => {
      const missingDir = path.join(tmpDir, 'does-not-exist')
      expect(() => cleanupStaleTempFiles(missingDir)).not.toThrow()
    })

    it('skips non-temp files', () => {
      const normalFile = path.join(tmpDir, 'regular.txt')
      fs.writeFileSync(normalFile, 'data', 'utf-8')
      cleanupStaleTempFiles(tmpDir)
      expect(fs.existsSync(normalFile)).toBe(true)
    })
  })

  describe('getConfigReaderLogger / setConfigReaderLogger', () => {
    it('returns the current logger after setConfigReaderLogger', async () => {
      const { getConfigReaderLogger, setConfigReaderLogger } = await import('../config-reader')
      const customLogger = { warn: vi.fn() }
      setConfigReaderLogger(customLogger)
      expect(getConfigReaderLogger()).toBe(customLogger)
      setConfigReaderLogger(console)
    })
  })
})