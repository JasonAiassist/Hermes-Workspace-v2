import { useCallback, useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowUp01Icon,
  ArrowDown01Icon,
  Delete01Icon,
  Edit01Icon,
  PlusSignIcon,
  RefreshIcon,
  Rocket01Icon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { isTaskCategory, type HubTask, type TaskComplexity, type TaskCategory } from './task-board'
import { createTaskId } from './task-board'

const COMPLEXITY_BADGE: Record<TaskComplexity, string> = {
  trivial: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  small: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  medium: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  large: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
}

const COMPLEXITY_LABEL: Record<TaskComplexity, string> = {
  trivial: 'Trivial',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
}

export type MissionPlanPreviewProps = {
  tasks: HubTask[]
  summary: string
  onTasksChange: (tasks: HubTask[]) => void
  onRegenerate: () => void
  onConfirm: () => void
  loading?: boolean
}

type EditState = {
  index: number
  title: string
  description: string
  category: TaskCategory
  complexity: TaskComplexity
}

export function MissionPlanPreview({
  tasks,
  summary,
  onTasksChange,
  onRegenerate,
  onConfirm,
  loading,
}: MissionPlanPreviewProps) {
  const [editState, setEditState] = useState<EditState | null>(null)
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null)

  const taskDepths = useMemo(() => {
    const depths = new Map<string, number>()
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const visiting = new Set<string>()

    function getDepth(id: string): number {
      if (depths.has(id)) return depths.get(id)!
      if (visiting.has(id)) {
        // Cycle detected — break it
        depths.set(id, 0)
        return 0
      }
      visiting.add(id)
      const task = taskById.get(id)
      if (!task || !task.dependencies?.length) {
        depths.set(id, 0)
        visiting.delete(id)
        return 0
      }
      const maxDepDepth = Math.max(...task.dependencies.map(getDepth))
      depths.set(id, maxDepDepth + 1)
      visiting.delete(id)
      return maxDepDepth + 1
    }

    tasks.forEach((t) => getDepth(t.id))
    return depths
  }, [tasks])

  const moveTask = useCallback(
    (index: number, direction: 'up' | 'down') => {
      if (direction === 'up' && index === 0) return
      if (direction === 'down' && index === tasks.length - 1) return
      const next = [...tasks]
      const swapIndex = direction === 'up' ? index - 1 : index + 1
      ;[next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!]
      onTasksChange(next)
    },
    [tasks, onTasksChange],
  )

  const deleteTask = useCallback(
    (index: number) => {
      const taskToDelete = tasks[index]
      if (!taskToDelete) return
      const deletedId = taskToDelete.id

      // Remove this task and any tasks that depend on it (transitively)
      const removedIds = new Set<string>([deletedId])
      let changed = true
      while (changed) {
        changed = false
        for (const t of tasks) {
          if (removedIds.has(t.id)) continue
          if (t.dependencies?.some((d) => removedIds.has(d))) {
            removedIds.add(t.id)
            changed = true
          }
        }
      }

      const keptTasks = tasks.filter((t) => !removedIds.has(t.id))

      // Strip deleted IDs from remaining task dependencies
      const cleaned = keptTasks.map((t) => ({
        ...t,
        dependencies: t.dependencies?.filter((d) => !removedIds.has(d)),
      }))

      onTasksChange(cleaned)
      setDeletingIndex(null)
    },
    [tasks, onTasksChange],
  )

  const addBlankTask = useCallback(() => {
    const now = Date.now()
    const newTask: HubTask = {
      id: createTaskId(),
      title: 'New Task',
      description: '',
      priority: 'normal',
      status: 'inbox',
      createdAt: now,
      updatedAt: now,
      category: 'other',
      estimatedComplexity: 'small',
      dependencies: [],
    }
    onTasksChange([...tasks, newTask])
  }, [tasks, onTasksChange])

  const startEdit = useCallback((index: number) => {
    const task = tasks[index]
    if (!task) return
    setEditState({
      index,
      title: task.title,
      description: task.description,
      category: task.category ?? 'other',
      complexity: task.estimatedComplexity || 'small',
    })
  }, [tasks])

  const saveEdit = useCallback(() => {
    if (!editState) return
    const next = tasks.map((t, i) =>
      i === editState.index
        ? {
            ...t,
            title: editState.title.trim() || t.title,
            description: editState.description,
            category: editState.category,
            estimatedComplexity: editState.complexity,
          }
        : t,
    )
    onTasksChange(next)
    setEditState(null)
  }, [editState, tasks, onTasksChange])

  const cancelEdit = useCallback(() => {
    setEditState(null)
  }, [])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--theme-accent)]">
          Mission Plan Preview
        </p>
        <h2 className="text-xl font-semibold tracking-tight text-[var(--theme-text)]">
          {summary}
        </h2>
        <p className="text-sm text-[var(--theme-muted-2)]">
          Review, edit, and reorder tasks before dispatching to agents.
        </p>
      </div>

      {/* Task list */}
      <div className="space-y-2">
        {tasks.map((task, index) => {
          const depth = taskDepths.get(task.id) ?? 0
          const isEditing = editState?.index === index
          const isDeleting = deletingIndex === index

          return (
            <div
              key={task.id}
              className={cn(
                'rounded-xl border bg-[var(--theme-card)] transition-colors',
                isDeleting
                  ? 'border-red-400/40 bg-red-500/5'
                  : 'border-[var(--theme-border)]',
              )}
              style={{ marginLeft: `${depth * 16}px` }}
            >
              {isDeleting ? (
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <p className="text-sm text-red-600">
                    Delete &quot;{task.title}&quot;? Dependent tasks will also be removed.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDeletingIndex(null)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--theme-muted)] hover:bg-[var(--theme-card2)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTask(index)}
                      className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : isEditing ? (
                <div className="space-y-3 px-4 py-3">
                  <input
                    type="text"
                    value={editState.title}
                    onChange={(e) => setEditState((s) => (s ? { ...s, title: e.target.value } : s))}
                    className="w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
                  />
                  <textarea
                    value={editState.description}
                    onChange={(e) => setEditState((s) => (s ? { ...s, description: e.target.value } : s))}
                    rows={2}
                    className="w-full resize-none rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
                    placeholder="Description"
                  />
                  <div className="flex items-center gap-2">
                    <select
                      value={editState.category}
                      onChange={(e) => setEditState((s) => (s ? { ...s, category: e.target.value as TaskCategory } : s))}
                      className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-xs text-[var(--theme-text)]"
                    >
                      {['research', 'code', 'review', 'deploy', 'testing', 'docs', 'design', 'analysis', 'data', 'other'].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <select
                      value={editState.complexity}
                      onChange={(e) => setEditState((s) => (s ? { ...s, complexity: e.target.value as TaskComplexity } : s))}
                      className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1.5 text-xs text-[var(--theme-text)]"
                    >
                      {(['trivial', 'small', 'medium', 'large'] as TaskComplexity[]).map((c) => (
                        <option key={c} value={c}>{COMPLEXITY_LABEL[c]}</option>
                      ))}
                    </select>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--theme-muted)] hover:bg-[var(--theme-card2)]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveEdit}
                        className="rounded-lg bg-[var(--theme-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--theme-accent-strong)]"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 px-4 py-3">
                  {/* Drag / depth indicator */}
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => moveTask(index, 'up')}
                      disabled={index === 0}
                      className="rounded p-0.5 text-[var(--theme-muted)] hover:bg-[var(--theme-card2)] disabled:opacity-30"
                      title="Move up"
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTask(index, 'down')}
                      disabled={index === tasks.length - 1}
                      className="rounded p-0.5 text-[var(--theme-muted)] hover:bg-[var(--theme-card2)] disabled:opacity-30"
                      title="Move down"
                    >
                      <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
                    </button>
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-[var(--theme-text)]">
                        {index + 1}. {task.title}
                      </p>
                      {task.estimatedComplexity && (
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                            COMPLEXITY_BADGE[task.estimatedComplexity],
                          )}
                        >
                          {COMPLEXITY_LABEL[task.estimatedComplexity]}
                        </span>
                      )}
                      {task.category && (
                        <span className="shrink-0 rounded-full bg-[var(--theme-card2)] px-2 py-0.5 text-[10px] font-medium text-[var(--theme-muted)]">
                          {task.category}
                        </span>
                      )}
                    </div>
                    {task.description && (
                      <p className="mt-1 text-xs text-[var(--theme-muted-2)]">{task.description}</p>
                    )}
                    {task.requiredSkills && task.requiredSkills.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {task.requiredSkills.map((skill) => (
                          <span
                            key={skill}
                            className="rounded bg-[var(--theme-card2)] px-1.5 py-0.5 text-[10px] text-[var(--theme-muted)]"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    )}
                    {task.dependencies && task.dependencies.length > 0 && (
                      <p className="mt-1 text-[10px] text-[var(--theme-muted)]">
                        Depends on: {task.dependencies.join(', ')}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(index)}
                      className="rounded p-1 text-[var(--theme-muted)] hover:bg-[var(--theme-card2)]"
                      title="Edit"
                    >
                      <HugeiconsIcon icon={Edit01Icon} size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingIndex(index)}
                      className="rounded p-1 text-[var(--theme-muted)] hover:bg-red-500/10 hover:text-red-500"
                      title="Delete"
                    >
                      <HugeiconsIcon icon={Delete01Icon} size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Add task */}
      <button
        type="button"
        onClick={addBlankTask}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-card)] py-3 text-sm font-medium text-[var(--theme-muted)] transition-colors hover:border-[var(--theme-accent)] hover:text-[var(--theme-accent)]"
      >
        <HugeiconsIcon icon={PlusSignIcon} size={16} />
        Add Task
      </button>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-2.5 text-sm font-medium text-[var(--theme-text)] transition-colors hover:bg-[var(--theme-card2)] disabled:opacity-50"
        >
          <HugeiconsIcon icon={RefreshIcon} size={16} className={cn(loading && 'animate-spin')} />
          Regenerate Plan
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading || tasks.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-[var(--theme-accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--theme-accent-strong)] disabled:opacity-50"
        >
          <HugeiconsIcon icon={Rocket01Icon} size={16} />
          Confirm & Dispatch
        </button>
      </div>
    </div>
  )
}
