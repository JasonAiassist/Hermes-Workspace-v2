import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './parse-frontmatter'
import type { SkillCatalog, SkillCatalogEntry } from './types'

const SKILLS_DIRS = [
  join(process.env.HOME ?? '~', '.hermes', 'skills'),
]

function findSkillFiles(dir: string): string[] {
  const results: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findSkillFiles(fullPath))
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return results
}

function estimateTokens(content: string): number {
  return Math.round(content.length / 4)
}

function extractDescription(frontmatter: Record<string, unknown>, body: string): string {
  if (typeof frontmatter.description === 'string' && frontmatter.description.trim()) {
    return frontmatter.description.trim().slice(0, 200)
  }
  // Fall back to first paragraph of body
  const firstPara = body.replace(/^#+\s+.*$/m, '').trim().split('\n\n')[0]
  if (firstPara) {
    return firstPara.trim().slice(0, 200)
  }
  return '(no description)'
}

function extractTriggers(frontmatter: Record<string, unknown>): string[] {
  if (Array.isArray(frontmatter.triggers)) {
    return frontmatter.triggers.filter((t): t is string => typeof t === 'string')
  }
  if (typeof frontmatter.triggers === 'string') {
    return [frontmatter.triggers]
  }
  // Auto-generate from name + category + description keywords
  const triggers: string[] = []
  if (typeof frontmatter.name === 'string') {
    triggers.push(...frontmatter.name.split(/[-_]/))
  }
  if (typeof frontmatter.category === 'string') {
    triggers.push(frontmatter.category)
  }
  return [...new Set(triggers)].filter(Boolean)
}

function extractDependsOn(frontmatter: Record<string, unknown>): string[] {
  if (Array.isArray(frontmatter.depends_on)) {
    return frontmatter.depends_on.filter((d): d is string => typeof d === 'string')
  }
  return []
}

function parseSkillFile(filePath: string): SkillCatalogEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)

    const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : null
    if (!name) {
      return null // Skip files without a name
    }

    return {
      name,
      description: extractDescription(frontmatter, body),
      category: typeof frontmatter.category === 'string' ? frontmatter.category : 'uncategorized',
      estimatedTokens: estimateTokens(content),
      triggers: extractTriggers(frontmatter),
      dependsOn: extractDependsOn(frontmatter),
      filePath,
    }
  } catch {
    return null
  }
}

export function generateCatalog(dirs: string[] = SKILLS_DIRS): SkillCatalog {
  const allFiles = dirs.flatMap(findSkillFiles)
  const skills = allFiles
    .map(parseSkillFile)
    .filter((s): s is SkillCatalogEntry => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    skillsCount: skills.length,
    totalEstimatedTokens: skills.reduce((sum, s) => sum + s.estimatedTokens, 0),
    skills,
  }
}