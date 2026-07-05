/**
 * Mission-planner domain types.
 *
 * v2 forward-port: the old fork sourced these from `@/lib/gateway-types`,
 * which does not exist in v2 (the UI's `HubTask`/`TeamMember` live inside
 * `.tsx` component files and lack the planner-specific fields
 * `category`, `requiredSkills`, `estimatedComplexity`, `dependencies`,
 * `specialties`, `maxConcurrentTasks`). Keeping the planner as pure
 * server-side TypeScript with no UI imports requires a self-contained
 * types module, so the planner never reaches into React component files.
 */

// ---------------------------------------------------------------------------
// Enum-like unions shared across planner modules
// ---------------------------------------------------------------------------

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export type TaskStatus =
  | 'inbox'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked'

export type TaskCategory =
  | 'research'
  | 'code'
  | 'review'
  | 'deploy'
  | 'testing'
  | 'docs'
  | 'design'
  | 'analysis'
  | 'data'
  | 'other'

export type TaskComplexity = 'trivial' | 'small' | 'medium' | 'large'

const TASK_CATEGORIES: readonly TaskCategory[] = [
  'research',
  'code',
  'review',
  'deploy',
  'testing',
  'docs',
  'design',
  'analysis',
  'data',
  'other',
]

// ---------------------------------------------------------------------------
// Planner task + team member shapes (supersets of v2's UI types; the extra
// fields are optional so the planner stays JSON-compatible with the UI).
// ---------------------------------------------------------------------------

export type HubTask = {
  id: string
  title: string
  description: string
  priority: TaskPriority
  status: TaskStatus
  agentId?: string
  /** ID of the mission that created this task. Used to filter stale tasks. */
  missionId?: string
  createdAt: number
  updatedAt: number
  category?: TaskCategory
  requiredSkills?: string[]
  estimatedComplexity?: TaskComplexity
  /** IDs of tasks that must finish before this one can start. */
  dependencies?: string[]
}

export type TeamMember = {
  id: string
  name: string
  avatar?: number
  modelId: string
  roleDescription: string
  goal: string
  backstory: string
  status: string
  memoryPath?: string
  skillAllowlist?: string[]
  modelOverride?: string
  /** Skill keywords used by the agent matcher for specialty overlap. */
  specialties?: string[]
  /** Max tasks this agent can hold concurrently (load balancing). */
  maxConcurrentTasks?: number
  costPreference?: 'capable' | 'efficient'
}

// ---------------------------------------------------------------------------
// Identity / validation helpers
// ---------------------------------------------------------------------------

/**
 * Short, collision-resistant task id. Mirrors the UI's `createTaskId` so
 * planner-generated tasks slot into the existing task board without remapping.
 */
export function createTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Runtime guard that narrows an unknown string to a known TaskCategory. */
export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === 'string' && (TASK_CATEGORIES as readonly string[]).includes(value)
}

export { TASK_CATEGORIES }
