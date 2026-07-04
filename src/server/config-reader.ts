import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'

export type ConfigReaderLogger = {
  warn: (...args: unknown[]) => void
}

let logger: ConfigReaderLogger = console

export function setConfigReaderLogger(l: ConfigReaderLogger): void {
  logger = l
}

export function getConfigReaderLogger(): ConfigReaderLogger {
  return logger
}

/**
 * Safely read and parse a YAML config file.
 * Returns an empty object if the file does not exist or cannot be parsed.
 */
export function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    logger.warn(`[config-reader] ${configPath}: parsed value is not an object, returning empty config`)
    return {}
  } catch (err) {
    logger.warn(`[config-reader] Failed to read ${configPath}:`, err instanceof Error ? err.message : String(err))
    return {}
  }
}

/**
 * Write raw text to a file atomically via temp-file + rename.
 * Prevents partial writes if the process crashes mid-write.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    // Cross-device move (EXDEV) — fall back to copy + unlink
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
      try {
        fs.copyFileSync(tmpPath, filePath)
      } catch (copyErr) {
        // If copy also fails, clean up temp file and rethrow the COPY error
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        throw copyErr
      }
      // Copy succeeded — best-effort cleanup of temp file
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
      throw err
    }
  }
}

/**
 * Remove orphaned temp files left behind by crashed atomic writes.
 * Safe to call on startup or after a crash.
 */
export function cleanupStaleTempFiles(baseDir: string, maxAgeMs = 300_000): void {
  if (!fs.existsSync(baseDir)) return
  const now = Date.now()
  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.includes('.tmp.')) continue
    const fullPath = path.join(baseDir, entry.name)
    try {
      const stat = fs.statSync(fullPath)
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath)
      }
    } catch {
      // ignore — file may have been removed by another process
    }
  }
}

/**
 * Write a config object to a YAML file, creating parent directories if needed.
 * Uses atomic temp-file rename to prevent partial writes on crash.
 */
export function writeYamlConfig(
  configPath: string,
  config: Record<string, unknown>,
): void {
  writeFileAtomic(configPath, YAML.stringify(config))
}