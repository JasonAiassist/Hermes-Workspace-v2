import type { SkillCatalog, SkillCatalogEntry } from './types'

export type SearchResult = {
  name: string
  description: string
  relevanceScore: number
}

function scoreSkill(query: string, skill: SkillCatalogEntry): number {
  const q = query.toLowerCase()
  const name = skill.name.toLowerCase()
  const desc = skill.description.toLowerCase()

  // Exact name match
  if (name === q) return 1.0

  // Name contains query
  if (name.includes(q)) return 0.8

  // Trigger match
  for (const trigger of skill.triggers) {
    const t = trigger.toLowerCase()
    if (t === q) return 0.9
    if (t.includes(q)) return 0.7
  }

  // Description contains query
  if (desc.includes(q)) return 0.5

  return 0.0
}

export function searchSkills(
  catalog: SkillCatalog,
  query: string,
  limit: number = 5,
): SearchResult[] {
  if (!query.trim()) return []

  const results = catalog.skills
    .map((skill): SearchResult & { score: number } => ({
      name: skill.name,
      description: skill.description,
      relevanceScore: scoreSkill(query, skill),
      score: scoreSkill(query, skill),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return results.map(({ name, description, relevanceScore }) => ({
    name,
    description,
    relevanceScore: Math.round(relevanceScore * 100) / 100,
  }))
}