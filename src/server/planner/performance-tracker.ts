import type { HubTask } from '@/screens/gateway/components/task-board'
import type { TeamMember } from '@/screens/gateway/components/team-panel'

// ---------------------------------------------------------------------------
// Agent performance metrics tracked during a mission
// ---------------------------------------------------------------------------

export type AgentMetrics = {
  tasksAssigned: number
  tasksCompleted: number
  tasksFailed: number
  totalTokensUsed: number
  totalDurationMs: number
  lastDispatchAt?: number
  lastCompletionAt?: number
  /** Per-category performance for targeted historical scoring */
  categoryPerformance?: Record<string, { success: number; fail: number; avgDurationMs: number }>
}

// ---------------------------------------------------------------------------
// Create empty metrics
// ---------------------------------------------------------------------------

export function createEmptyMetrics(): AgentMetrics {
  return {
    tasksAssigned: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    totalTokensUsed: 0,
    totalDurationMs: 0,
    categoryPerformance: {},
  }
}

// ---------------------------------------------------------------------------
// Record a task dispatch
// ---------------------------------------------------------------------------

export function recordTaskDispatch(
  metrics: AgentMetrics,
  timestamp: number = Date.now(),
): AgentMetrics {
  return {
    ...metrics,
    tasksAssigned: metrics.tasksAssigned + 1,
    lastDispatchAt: timestamp,
  }
}

// ---------------------------------------------------------------------------
// Record a task completion
// ---------------------------------------------------------------------------

export function recordTaskCompletion(
  metrics: AgentMetrics,
  durationMs: number,
  timestamp: number = Date.now(),
  category?: string,
): AgentMetrics {
  const cp = { ...(metrics.categoryPerformance ?? {}) }
  if (category) {
    const entry = cp[category] ?? { success: 0, fail: 0, avgDurationMs: 0 }
    const newSuccess = entry.success + 1
    const newAvg = (entry.avgDurationMs * entry.success + durationMs) / newSuccess
    cp[category] = { ...entry, success: newSuccess, avgDurationMs: newAvg }
  }
  return {
    ...metrics,
    tasksCompleted: metrics.tasksCompleted + 1,
    totalDurationMs: metrics.totalDurationMs + durationMs,
    lastCompletionAt: timestamp,
    categoryPerformance: cp,
  }
}

// ---------------------------------------------------------------------------
// Record a task failure
// ---------------------------------------------------------------------------

export function recordTaskFailure(metrics: AgentMetrics, category?: string): AgentMetrics {
  const cp = { ...(metrics.categoryPerformance ?? {}) }
  if (category) {
    const entry = cp[category] ?? { success: 0, fail: 0, avgDurationMs: 0 }
    cp[category] = { ...entry, fail: entry.fail + 1 }
  }
  return {
    ...metrics,
    tasksFailed: metrics.tasksFailed + 1,
    categoryPerformance: cp,
  }
}

// ---------------------------------------------------------------------------
// Compute historical penalty/bonus for agent-task scoring
// Returns a delta in the range [-0.15, +0.10]
// ---------------------------------------------------------------------------

export function computeHistoricalScoreDelta(
  agentId: string,
  category: string | undefined,
  history: Record<string, AgentMetrics>,
): number {
  const metrics = history[agentId]
  if (!metrics) return 0

  const total = metrics.tasksCompleted + metrics.tasksFailed
  if (total < 2) return 0 // Not enough data

  const failureRate = metrics.tasksFailed / total
  let delta = 0

  // General failure rate penalty
  if (failureRate > 0.5) delta -= 0.10
  else if (failureRate > 0.3) delta -= 0.05
  else if (failureRate === 0 && total >= 3) delta += 0.05

  // Speed bonus for fast agents
  const avgDuration =
    metrics.tasksCompleted > 0 ? metrics.totalDurationMs / metrics.tasksCompleted : 0
  if (avgDuration > 0 && avgDuration < 30_000) delta += 0.03 // < 30s avg
  if (avgDuration > 0 && avgDuration > 120_000) delta -= 0.03 // > 2min avg

  // Category-specific bonus/penalty ( Sprint 3 fix )
  if (category && metrics.categoryPerformance?.[category]) {
    const cat = metrics.categoryPerformance[category]
    const catTotal = cat.success + cat.fail
    if (catTotal >= 2) {
      const catFailRate = cat.fail / catTotal
      if (catFailRate === 0 && catTotal >= 3) delta += 0.03
      else if (catFailRate > 0.5) delta -= 0.05
      else if (catFailRate > 0.3) delta -= 0.02
    }
  }

  return Math.max(-0.15, Math.min(0.10, delta))
}

// ---------------------------------------------------------------------------
// Build a metrics record from a mission's task history
// Blocked tasks are NOT counted as failed (retries may succeed)
// ---------------------------------------------------------------------------

export function buildAgentMetricsFromTasks(
  tasks: HubTask[],
  team: TeamMember[],
): Record<string, AgentMetrics> {
  const metrics: Record<string, AgentMetrics> = {}
  for (const member of team) {
    metrics[member.id] = createEmptyMetrics()
  }

  for (const task of tasks) {
    if (!task.agentId) continue
    const m = metrics[task.agentId] ?? createEmptyMetrics()
    metrics[task.agentId] = { ...m, tasksAssigned: m.tasksAssigned + 1 }
    if (task.status === 'done') {
      metrics[task.agentId] = { ...metrics[task.agentId], tasksCompleted: metrics[task.agentId].tasksCompleted + 1 }
    }
    // Note: 'blocked' is not counted as failed — retries may succeed
  }

  return metrics
}
