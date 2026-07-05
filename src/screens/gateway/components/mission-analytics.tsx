import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { HubTask } from './task-board'
import type { TeamMember } from './team-panel'
import type { AgentMetrics } from '@/server/planner/performance-tracker'

export type MissionAnalyticsProps = {
  tasks: HubTask[]
  team: TeamMember[]
  agentMetrics: Record<string, AgentMetrics>
  startedAt: number
  completedAt?: number
}

const STATUS_COLORS: Record<string, string> = {
  inbox: 'bg-neutral-300',
  assigned: 'bg-blue-300',
  in_progress: 'bg-amber-300',
  review: 'bg-purple-300',
  done: 'bg-emerald-400',
  blocked: 'bg-red-400',
}

const STATUS_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

export function computeMissionStats(
  tasks: HubTask[],
  team: TeamMember[],
  agentMetrics: Record<string, AgentMetrics>,
  startedAt: number,
  completedAt?: number,
) {
  const total = tasks.length
  const done = tasks.filter((t) => t.status === 'done').length
  const blocked = tasks.filter((t) => t.status === 'blocked').length
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0
  const durationMs = completedAt ? completedAt - startedAt : Date.now() - startedAt

  const agentStats = team.map((member) => {
    const metrics = agentMetrics[member.id]
    const agentTasks = tasks.filter((t) => t.agentId === member.id)
    return {
      id: member.id,
      name: member.name,
      tasksAssigned: metrics?.tasksAssigned ?? agentTasks.length,
      tasksCompleted: metrics?.tasksCompleted ?? agentTasks.filter((t) => t.status === 'done').length,
      tasksFailed: metrics?.tasksFailed ?? agentTasks.filter((t) => t.status === 'blocked').length,
      totalTokens: metrics?.totalTokensUsed ?? 0,
      totalDurationMs: metrics?.totalDurationMs ?? 0,
      avgDurationMs:
        metrics && metrics.tasksCompleted > 0
          ? Math.round(metrics.totalDurationMs / metrics.tasksCompleted)
          : 0,
    }
  })

  return { total, done, blocked, inProgress, completionRate, durationMs, agentStats }
}

export function MissionAnalytics({ tasks, team, agentMetrics, startedAt, completedAt }: MissionAnalyticsProps) {
  const stats = useMemo(
    () => computeMissionStats(tasks, team, agentMetrics, startedAt, completedAt),
    [tasks, team, agentMetrics, startedAt, completedAt],
  )

  return (
    <div className="space-y-6">
      {/* Header stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Tasks" value={`${stats.done}/${stats.total}`} />
        <StatCard label="Completion" value={`${stats.completionRate}%`} />
        <StatCard label="Blocked" value={String(stats.blocked)} />
        <StatCard label="Duration" value={formatDuration(stats.durationMs)} />
      </div>

      {/* Task timeline */}
      <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--theme-muted)]">
          Task Timeline
        </h3>
        <div className="mt-3 space-y-2">
          {tasks.map((task, index) => (
            <div key={task.id} className="flex items-center gap-3">
              <span className="w-5 text-right text-[10px] text-[var(--theme-muted)]">{index + 1}</span>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-[var(--theme-text)]">{task.title}</span>
                  <span
                    className={cn(
                      'inline-block size-2 rounded-full',
                      STATUS_COLORS[task.status] ?? 'bg-neutral-300',
                    )}
                    title={STATUS_LABELS[task.status] ?? task.status}
                  />
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--theme-bg)]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      task.status === 'done'
                        ? 'bg-emerald-400'
                        : task.status === 'blocked'
                          ? 'bg-red-400'
                          : task.status === 'in_progress'
                            ? 'bg-amber-300'
                            : 'bg-neutral-300',
                    )}
                    style={{ width: task.status === 'done' ? '100%' : task.status === 'in_progress' ? '60%' : '0%' }}
                  />
                </div>
              </div>
              {task.agentId && (
                <span className="shrink-0 text-[10px] text-[var(--theme-muted)]">
                  {team.find((m) => m.id === task.agentId)?.name ?? task.agentId.slice(0, 6)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Agent utilization */}
      <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--theme-muted)]">
          Agent Utilization
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {stats.agentStats.map((agent) => {
            const successRate =
              agent.tasksAssigned > 0
                ? Math.round(((agent.tasksAssigned - agent.tasksFailed) / agent.tasksAssigned) * 100)
                : 0
            return (
              <div
                key={agent.id}
                className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--theme-text)]">{agent.name}</span>
                  <span className="text-[10px] text-[var(--theme-muted)]">{successRate}% success</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--theme-card2)]">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        successRate >= 80 ? 'bg-emerald-400' : successRate >= 50 ? 'bg-amber-300' : 'bg-red-400',
                      )}
                      style={{ width: `${successRate}%` }}
                    />
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--theme-muted)]">
                  <span>{agent.tasksCompleted} done</span>
                  {agent.tasksFailed > 0 && <span className="text-red-400">{agent.tasksFailed} failed</span>}
                  {agent.totalTokens > 0 && <span>{(agent.totalTokens / 1000).toFixed(1)}K tokens</span>}
                  {agent.avgDurationMs > 0 && <span>{formatDuration(agent.avgDurationMs)} avg</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-3 text-center">
      <p className="text-lg font-semibold text-[var(--theme-text)]">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-[var(--theme-muted)]">{label}</p>
    </div>
  )
}
