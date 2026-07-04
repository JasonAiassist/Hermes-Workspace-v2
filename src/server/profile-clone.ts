import { existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MEMORY_SIZE_WARN_MB = 100

function getDirSize(dir: string): number {
  try {
    let size = 0
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        size += getDirSize(fullPath)
      } else {
        size += statSync(fullPath).size
      }
    }
    return size
  } catch {
    return 0
  }
}

export function copyMemory(
  sourceDir: string,
  targetDir: string,
): { copied: boolean; sizeMb: number; warning?: string } {
  const sourceMemory = join(sourceDir, 'memories')
  if (!existsSync(sourceMemory)) {
    return { copied: false, sizeMb: 0 }
  }

  const sizeBytes = getDirSize(sourceMemory)
  const sizeMb = Math.round(sizeBytes / (1024 * 1024))

  const targetMemory = join(targetDir, 'memory')
  mkdirSync(targetMemory, { recursive: true })
  cpSync(sourceMemory, targetMemory, { recursive: true, force: true })

  return {
    copied: true,
    sizeMb,
    ...(sizeMb > MEMORY_SIZE_WARN_MB
      ? { warning: `Memory directory is ${sizeMb}MB (threshold: ${MEMORY_SIZE_WARN_MB}MB)` }
      : {}),
  }
}