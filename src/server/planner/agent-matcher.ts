import type { HubTask, TeamMember } from './types'
import { computeHistoricalScoreDelta } from './performance-tracker'
import type { AgentMetrics } from './performance-tracker'

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHTS = {
  specialtyOverlap: 0.35,
  roleRelevance: 0.25,
  categoryFit: 0.20,
  modelCapability: 0.15,
  loadFactor: 0.05,
} as const

const MIN_SCORE = 0.15

// ---------------------------------------------------------------------------
// Model tier mapping (higher = more capable)
// ---------------------------------------------------------------------------

const MODEL_TIER: Record<string, number> = {
  'pc1-coder': 2,
  'pc1-planner': 3,
  'pc1-critic': 2,
  opus: 4,
  sonnet: 3,
  codex: 3,
  flash: 2,
  minimax: 2,
  auto: 2,
}

const COMPLEXITY_TIER: Record<string, number> = {
  trivial: 1,
  small: 1,
  medium: 2,
  large: 3,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 2)
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase().trim()))
  const setB = new Set(b.map((s) => s.toLowerCase().trim()))
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

function keywordOverlap(textA: string, textB: string): number {
  const tokensA = normalizeTokens(textA)
  const tokensB = normalizeTokens(textB)
  if (tokensA.length === 0 || tokensB.length === 0) return 0
  const setB = new Set(tokensB)
  let matches = 0
  for (const token of tokensA) {
    if (setB.has(token)) matches++
  }
  return matches / tokensA.length
}

function modelCapabilityScore(modelId: string, complexity?: string): number {
  const tier = MODEL_TIER[modelId] ?? 2
  const required = complexity ? (COMPLEXITY_TIER[complexity] ?? 2) : 2
  return tier >= required ? 1 : tier / required
}

function loadFactorScore(agentId: string, assignedCounts: Record<string, number>, maxConcurrent?: number): number {
  const count = assignedCounts[agentId] ?? 0
  const limit = maxConcurrent ?? 1
  if (count >= limit) return 0
  return 1 - count / limit
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

export type AgentScore = {
  agentId: string
  score: number
  breakdown: {
    specialtyOverlap: number
    roleRelevance: number
    categoryFit: number
    modelCapability: number
    loadFactor: number
  }
}

export function scoreAgentForTask(
  agent: TeamMember,
  task: HubTask,
  assignedCounts: Record<string, number> = {},
  history?: Record<string, AgentMetrics>,
): AgentScore {
  const specialtyOverlap = jaccardSimilarity(agent.specialties ?? [], task.requiredSkills ?? [])

  const roleText = [agent.roleDescription, agent.goal, agent.backstory].filter(Boolean).join(' ')
  const taskText = [task.title, task.description, task.category ?? ''].filter(Boolean).join(' ')
  const roleRelevance = keywordOverlap(roleText, taskText)

  const categoryFit = task.category && roleText.toLowerCase().includes(task.category.toLowerCase()) ? 1 : 0.2

  const modelCapability = modelCapabilityScore(agent.modelId, task.estimatedComplexity)

  const loadFactor = loadFactorScore(agent.id, assignedCounts, agent.maxConcurrentTasks)

  let score =
    specialtyOverlap * WEIGHTS.specialtyOverlap +
    roleRelevance * WEIGHTS.roleRelevance +
    categoryFit * WEIGHTS.categoryFit +
    modelCapability * WEIGHTS.modelCapability +
    loadFactor * WEIGHTS.loadFactor

  // Sprint 3: apply historical performance delta
  if (history) {
    const delta = computeHistoricalScoreDelta(agent.id, task.category, history)
    score = Math.max(0, Math.min(1, score + delta))
  }

  return {
    agentId: agent.id,
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      specialtyOverlap: Math.round(specialtyOverlap * 1000) / 1000,
      roleRelevance: Math.round(roleRelevance * 1000) / 1000,
      categoryFit: Math.round(categoryFit * 1000) / 1000,
      modelCapability: Math.round(modelCapability * 1000) / 1000,
      loadFactor: Math.round(loadFactor * 1000) / 1000,
    },
  }
}

export function findBestAgentForTask(
  task: HubTask,
  agents: TeamMember[],
  assignedCounts: Record<string, number> = {},
  excludeAgentIds: Set<string> = new Set(),
  history?: Record<string, AgentMetrics>,
): TeamMember | null {
  const scores = agents
    .filter((agent) => !excludeAgentIds.has(agent.id))
    .map((agent) => scoreAgentForTask(agent, task, assignedCounts, history))
    .filter((result) => result.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)

  if (scores.length === 0) return null
  return agents.find((a) => a.id === scores[0]!.agentId) ?? null
}

export function buildAssignmentMatrix(
  tasks: HubTask[],
  agents: TeamMember[],
  options?: {
    assignedCounts?: Record<string, number>
    excludeAgentIds?: Set<string>
    requireAllAssigned?: boolean
    history?: Record<string, AgentMetrics>
  },
): { assignments: Map<string, string>; unassigned: string[]; scores: Map<string, AgentScore> } {
  const assignedCounts = { ...(options?.assignedCounts ?? {}) }
  const excludeAgentIds = options?.excludeAgentIds ?? new Set()
  const history = options?.history
  const assignments = new Map<string, string>()
  const scores = new Map<string, AgentScore>()
  const unassigned: string[] = []

  for (const task of tasks) {
    // If task already has a valid agent assignment, respect it
    if (task.agentId && agents.some((a) => a.id === task.agentId) && !excludeAgentIds.has(task.agentId)) {
      assignments.set(task.id, task.agentId)
      assignedCounts[task.agentId] = (assignedCounts[task.agentId] ?? 0) + 1
      continue
    }

    const best = findBestAgentForTask(task, agents, assignedCounts, excludeAgentIds, history)
    if (best) {
      assignments.set(task.id, best.id)
      const score = scoreAgentForTask(best, task, assignedCounts, history)
      scores.set(task.id, score)
      assignedCounts[best.id] = (assignedCounts[best.id] ?? 0) + 1
    } else {
      unassigned.push(task.id)
    }
  }

  return { assignments, unassigned, scores }
}
