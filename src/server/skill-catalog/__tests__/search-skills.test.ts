import { describe, it, expect } from 'vitest'
import { searchSkills } from '../search-skills'
import type { SkillCatalog } from '../types'

function makeCatalog(skills: Array<{ name: string; description: string; triggers?: string[] }>): SkillCatalog {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    skillsCount: skills.length,
    totalEstimatedTokens: 0,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      category: 'test',
      estimatedTokens: 100,
      triggers: s.triggers ?? [],
      dependsOn: [],
      filePath: `/test/${s.name}.md`,
    })),
  }
}

describe('searchSkills', () => {
  it('returns empty array for empty query', () => {
    const catalog = makeCatalog([{ name: 'debug', description: 'Debug skill' }])
    expect(searchSkills(catalog, '')).toEqual([])
  })

  it('returns empty array when no matches', () => {
    const catalog = makeCatalog([{ name: 'deploy', description: 'Deploy things' }])
    expect(searchSkills(catalog, 'nonexistent')).toEqual([])
  })

  it('exact name match scores 1.0', () => {
    const catalog = makeCatalog([
      { name: 'systematic-debugging', description: 'Debug methodically' },
      { name: 'other', description: 'Other skill' },
    ])
    const results = searchSkills(catalog, 'systematic-debugging')
    expect(results).toHaveLength(1)
    expect(results[0].relevanceScore).toBe(1.0)
  })

  it('partial name match scores 0.8', () => {
    const catalog = makeCatalog([
      { name: 'github-pr-workflow', description: 'PR workflow' },
      { name: 'other', description: 'Other' },
    ])
    const results = searchSkills(catalog, 'github')
    expect(results[0].relevanceScore).toBe(0.8)
  })

  it('exact trigger match scores 0.9', () => {
    const catalog = makeCatalog([
      { name: 'debug', description: 'Debug', triggers: ['traceback', 'error'] },
    ])
    const results = searchSkills(catalog, 'traceback')
    expect(results[0].relevanceScore).toBe(0.9)
  })

  it('partial trigger match scores 0.7', () => {
    const catalog = makeCatalog([
      { name: 'debug', description: 'Debug', triggers: ['traceback', 'error'] },
    ])
    const results = searchSkills(catalog, 'trac')
    expect(results[0].relevanceScore).toBe(0.7)
  })

  it('description match scores 0.5', () => {
    const catalog = makeCatalog([
      { name: 'deploy', description: 'Deploy to production servers' },
    ])
    const results = searchSkills(catalog, 'production')
    expect(results[0].relevanceScore).toBe(0.5)
  })

  it('respects limit parameter', () => {
    const catalog = makeCatalog([
      { name: 'aaa', description: 'A' },
      { name: 'aab', description: 'A' },
      { name: 'aac', description: 'A' },
      { name: 'aad', description: 'A' },
    ])
    const results = searchSkills(catalog, 'aa', 2)
    expect(results).toHaveLength(2)
  })

  it('sorts by relevance descending', () => {
    const catalog = makeCatalog([
      { name: 'exact-match', description: 'Desc', triggers: ['exact'] },
      { name: 'partial-match-name', description: 'Desc' },
      { name: 'no-match-desc', description: 'Has exact keyword here' },
    ])
    const results = searchSkills(catalog, 'exact')
    expect(results[0].name).toBe('exact-match')
    expect(results[0].relevanceScore).toBeGreaterThanOrEqual(results[1].relevanceScore)
  })
})