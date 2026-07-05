import type { HubTask } from './types'

// ---------------------------------------------------------------------------
// Topological sort of tasks by dependency graph
// ---------------------------------------------------------------------------

export function topologicalSort(tasks: HubTask[]): HubTask[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const task of tasks) {
    inDegree.set(task.id, 0)
    adj.set(task.id, [])
  }

  for (const task of tasks) {
    for (const depId of task.dependencies ?? []) {
      if (!taskById.has(depId)) continue
      adj.get(depId)!.push(task.id)
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const result: HubTask[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const task = taskById.get(id)
    if (task) result.push(task)

    for (const neighbor of adj.get(id) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, nextDegree)
      if (nextDegree === 0) queue.push(neighbor)
    }
  }

  // If there are cycles, append remaining tasks in original order
  if (result.length < tasks.length) {
    const seen = new Set(result.map((t) => t.id))
    for (const task of tasks) {
      if (!seen.has(task.id)) result.push(task)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Get tasks whose dependencies are all completed
// ---------------------------------------------------------------------------

export function getReadyTasks(tasks: HubTask[], completedIds: Set<string>): HubTask[] {
  return tasks.filter((task) => {
    if (task.status === 'done' || task.status === 'in_progress') return false
    if (completedIds.has(task.id)) return false
    const deps = task.dependencies ?? []
    return deps.length === 0 || deps.every((id: string) => completedIds.has(id))
  })
}

// ---------------------------------------------------------------------------
// Build dependency graph description for prompts
// ---------------------------------------------------------------------------

export function buildDependencyGraphDescription(tasks: HubTask[]): string {
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  const lines: string[] = []
  for (const task of tasks) {
    const deps = task.dependencies ?? []
    if (deps.length === 0) {
      lines.push(`- ${task.title} (no dependencies)`)
    } else {
      const depTitles = deps
        .map((id: string) => taskById.get(id)?.title ?? id)
        .join(', ')
      lines.push(`- ${task.title} → depends on: ${depTitles}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build assignment matrix description for prompts
// ---------------------------------------------------------------------------

export function buildAssignmentDescription(
  tasks: HubTask[],
  agents: Array<{ id: string; name: string }>,
): string {
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]))
  const lines = tasks.map((task) => {
    const assignee = task.agentId ? agentNameById.get(task.agentId) ?? task.agentId : 'Unassigned'
    return `- ${task.title} → ${assignee}`
  })
  return lines.join('\n')
}
