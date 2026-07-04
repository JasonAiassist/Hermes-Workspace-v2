export type SkillCatalogEntry = {
  name: string
  description: string
  category: string
  estimatedTokens: number
  triggers: string[]
  dependsOn: string[]
  filePath: string
}

export type SkillCatalog = {
  schemaVersion: string
  generatedAt: string
  skillsCount: number
  totalEstimatedTokens: number
  skills: SkillCatalogEntry[]
}