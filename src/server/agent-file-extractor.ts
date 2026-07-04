/**
 * Agent File Tag Writer
 *
 * Server-side companion to file-tag-parser. Writes extracted files to disk.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { extractFileTags, type ExtractedFile } from '../lib/file-tag-parser'

const WORKSPACE_ROOT = (
  process.env.HERMES_WORKSPACE_DIR ||
  process.env.HERMES_HOME ||
  path.join(process.env.HOME || '/tmp', '.hermes')
).trim()

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'untitled-mission'
}

function makeUniqueMissionSlug(slug: string): string {
  const missionsDir = path.join(WORKSPACE_ROOT, 'Missions')
  let existing: string[] = []
  try {
    existing = readdirSync(missionsDir)
  } catch {
    return slug
  }

  const existingSet = new Set(existing)
  if (!existingSet.has(slug)) return slug

  let counter = 2
  let candidate = `${slug}-${counter}`
  while (existingSet.has(candidate)) {
    counter++
    candidate = `${slug}-${counter}`
  }
  return candidate
}

function ensureWorkspacePath(input: string): string {
  const raw = input.trim()
  if (!raw) return WORKSPACE_ROOT
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(WORKSPACE_ROOT, raw)
  if (resolved === WORKSPACE_ROOT) return resolved
  const relative = path.relative(WORKSPACE_ROOT, resolved)
  if (
    !relative ||
    relative.startsWith('..') ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Path is outside workspace')
  }
  return resolved
}

function ensureMissionMd(missionDir: string, missionName: string, agentId?: string) {
  const missionMdPath = path.join(missionDir, 'mission.md')
  if (existsSync(missionMdPath)) return

  const content = `# Mission: ${missionName}

## Goal
<!-- Mission goal goes here -->

## Architecture Decisions
<!-- Record key decisions as they are made -->

## Agent Assignments
| Agent | Task | Status | Output Path |
|-------|------|--------|-------------|
${agentId ? `| ${agentId} | — | in-progress | — |\n` : ''}

## File Map
<!-- Map of generated files and their purposes -->

## Open Questions
<!-- Track blockers and questions -->
`
  try {
    mkdirSync(missionDir, { recursive: true })
    writeFileSync(missionMdPath, content, 'utf8')
    console.log(
      JSON.stringify({
        event: 'agent-file-extractor.mission-md-created',
        path: missionMdPath,
        missionName,
        timestamp: new Date().toISOString(),
      }),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[agent-file-extractor] mission.md creation failed:', msg)
  }
}

export function writeExtractedFiles(
  files: ExtractedFile[],
  options?: { baseDir?: string; source?: string; missionName?: string; agentId?: string },
): { written: string[]; errors: string[] } {
  const written: string[] = []
  const errors: string[] = []

  // Build mission-scoped base directory when mission context is available
  let baseDir = options?.baseDir || WORKSPACE_ROOT
  let missionDir: string | undefined
  if (options?.missionName) {
    let missionSlug = slugify(options.missionName)
    missionSlug = makeUniqueMissionSlug(missionSlug)
    missionDir = path.join(WORKSPACE_ROOT, 'Missions', missionSlug)
    baseDir = missionDir
    ensureMissionMd(missionDir, options.missionName)
  }

  for (const file of files) {
    try {
      const rawPath = file.path.trim()
      if (!rawPath || rawPath === '.' || rawPath === '..') {
        throw new Error('Invalid file path: empty or relative root')
      }
      const targetPath = ensureWorkspacePath(
        path.join(baseDir, rawPath),
      )
      mkdirSync(path.dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, file.content, 'utf8')
      written.push(file.path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${file.path}: ${msg}`)
      console.warn('[agent-file-extractor] write failed:', msg)
    }
  }

  if (written.length > 0) {
    console.log(
      JSON.stringify({
        event: 'agent-file-extractor.written',
        files: written,
        source: options?.source || 'unknown',
        missionName: options?.missionName,
        agentId: options?.agentId,
        timestamp: new Date().toISOString(),
      }),
    )
  }

  return { written, errors }
}

export { extractFileTags, type ExtractedFile }