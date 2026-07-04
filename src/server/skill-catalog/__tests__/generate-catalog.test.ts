import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateCatalog } from '../generate-catalog'

const mockReaddirSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockStatSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
}))

describe('generateCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('generates empty catalog when no skills found', () => {
    mockReaddirSync.mockReturnValue([])
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.schemaVersion).toBe('1.0')
    expect(catalog.skillsCount).toBe(0)
    expect(catalog.totalEstimatedTokens).toBe(0)
    expect(catalog.skills).toEqual([])
  })

  it('skips files without name in frontmatter', () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/fake/skills') {
        return [
          { name: 'bad-skill', isDirectory: () => true, isFile: () => false },
        ]
      }
      if (dir === '/fake/skills/bad-skill') {
        return [
          { name: 'SKILL.md', isDirectory: () => false, isFile: () => true },
        ]
      }
      return []
    })
    mockReadFileSync.mockReturnValue('---\n---\n\nNo name here.')
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.skillsCount).toBe(0)
  })

  it('parses a valid skill and estimates tokens', () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/fake/skills') {
        return [
          { name: 'github-pr', isDirectory: () => true, isFile: () => false },
        ]
      }
      if (dir === '/fake/skills/github-pr') {
        return [
          { name: 'SKILL.md', isDirectory: () => false, isFile: () => true },
        ]
      }
      return []
    })
    const skillContent = `---
name: github-pr-workflow
description: "GitHub PR lifecycle"
category: github
triggers: ["git", "PR", "merge"]
depends_on: ["github-auth"]
---

# GitHub PR Workflow

Complete guide for managing PRs.
`
    mockReadFileSync.mockReturnValue(skillContent)
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.skillsCount).toBe(1)
    expect(catalog.skills[0].name).toBe('github-pr-workflow')
    expect(catalog.skills[0].description).toBe('GitHub PR lifecycle')
    expect(catalog.skills[0].category).toBe('github')
    expect(catalog.skills[0].triggers).toEqual(['git', 'PR', 'merge'])
    expect(catalog.skills[0].dependsOn).toEqual(['github-auth'])
    expect(catalog.skills[0].estimatedTokens).toBeGreaterThan(0)
    expect(catalog.totalEstimatedTokens).toBe(catalog.skills[0].estimatedTokens)
  })

  it('sorts skills alphabetically', () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/fake/skills') {
        return [
          { name: 'z-skill', isDirectory: () => true, isFile: () => false },
          { name: 'a-skill', isDirectory: () => true, isFile: () => false },
        ]
      }
      if (dir === '/fake/skills/z-skill') {
        return [{ name: 'SKILL.md', isDirectory: () => false, isFile: () => true }]
      }
      if (dir === '/fake/skills/a-skill') {
        return [{ name: 'SKILL.md', isDirectory: () => false, isFile: () => true }]
      }
      return []
    })
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('z-skill')) {
        return '---\nname: zebra-skill\n---\n\nZebra content.'
      }
      return '---\nname: alpha-skill\n---\n\nAlpha content.'
    })
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.skills.map((s) => s.name)).toEqual(['alpha-skill', 'zebra-skill'])
  })

  it('falls back to body first paragraph for missing description', () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/fake/skills') {
        return [
          { name: 'no-desc', isDirectory: () => true, isFile: () => false },
        ]
      }
      if (dir === '/fake/skills/no-desc') {
        return [{ name: 'SKILL.md', isDirectory: () => false, isFile: () => true }]
      }
      return []
    })
    mockReadFileSync.mockReturnValue('---\nname: no-desc-skill\n---\n\nThis is the first paragraph of the body.\n\nSecond paragraph.')
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.skills[0].description).toBe('This is the first paragraph of the body.')
  })

  it('auto-generates triggers from name when not provided', () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/fake/skills') {
        return [
          { name: 'my-test-skill', isDirectory: () => true, isFile: () => false },
        ]
      }
      if (dir === '/fake/skills/my-test-skill') {
        return [{ name: 'SKILL.md', isDirectory: () => false, isFile: () => true }]
      }
      return []
    })
    mockReadFileSync.mockReturnValue('---\nname: my-test-skill\ncategory: testing\n---\n\nBody.')
    const catalog = generateCatalog(['/fake/skills'])
    expect(catalog.skills[0].triggers).toContain('my')
    expect(catalog.skills[0].triggers).toContain('test')
    expect(catalog.skills[0].triggers).toContain('skill')
    expect(catalog.skills[0].triggers).toContain('testing')
  })

  it('handles unreadable directories gracefully', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('Permission denied')
    })
    const catalog = generateCatalog(['/unreadable'])
    expect(catalog.skillsCount).toBe(0)
  })
})