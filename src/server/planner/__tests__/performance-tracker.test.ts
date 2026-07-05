import { describe, it, expect } from 'vitest'
import {
  createEmptyMetrics,
  recordTaskDispatch,
  recordTaskCompletion,
  recordTaskFailure,
  computeHistoricalScoreDelta,
  buildAgentMetricsFromTasks,
} from '../performance-tracker'
import type { AgentMetrics } from '../performance-tracker'
import type { HubTask, TeamMember } from '../types'

function makeTask(overrides: Partial<HubTask> = {}): HubTask {
  return {
    id: 't-1',
    title: 'Task',
    description: '',
    priority: 'normal',
    status: 'inbox',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'a1',
    name: 'A1',
    modelId: 'auto',
    status: 'available',
    roleDescription: '',
    goal: '',
    backstory: '',
    ...overrides,
  }
}

describe('performance-tracker', () => {
  describe('createEmptyMetrics', () => {
    it('returns zeroed metrics with empty categoryPerformance', () => {
      const m = createEmptyMetrics()
      expect(m.tasksAssigned).toBe(0)
      expect(m.tasksCompleted).toBe(0)
      expect(m.tasksFailed).toBe(0)
      expect(m.totalTokensUsed).toBe(0)
      expect(m.totalDurationMs).toBe(0)
      expect(m.categoryPerformance).toEqual({})
      expect(m.lastDispatchAt).toBeUndefined()
      expect(m.lastCompletionAt).toBeUndefined()
    })
  })

  describe('recordTaskDispatch', () => {
    it('increments tasksAssigned and stamps lastDispatchAt', () => {
      const m = recordTaskDispatch(createEmptyMetrics(), 1000)
      expect(m.tasksAssigned).toBe(1)
      expect(m.lastDispatchAt).toBe(1000)
    })

    it('defaults timestamp to Date.now() when omitted', () => {
      const before = Date.now()
      const m = recordTaskDispatch(createEmptyMetrics())
      const after = Date.now()
      expect(m.lastDispatchAt).toBeGreaterThanOrEqual(before)
      expect(m.lastDispatchAt).toBeLessThanOrEqual(after)
    })

    it('does not mutate the input metrics', () => {
      const base = createEmptyMetrics()
      recordTaskDispatch(base, 5)
      expect(base.tasksAssigned).toBe(0)
    })
  })

  describe('recordTaskCompletion', () => {
    it('increments tasksCompleted, adds duration, stamps completion time', () => {
      const m = recordTaskCompletion(createEmptyMetrics(), 5000, 2000)
      expect(m.tasksCompleted).toBe(1)
      expect(m.totalDurationMs).toBe(5000)
      expect(m.lastCompletionAt).toBe(2000)
    })

    it('tracks running average per category across completions', () => {
      const m1 = recordTaskCompletion(createEmptyMetrics(), 5000, 2000, 'code')
      expect(m1.categoryPerformance!.code.success).toBe(1)
      expect(m1.categoryPerformance!.code.avgDurationMs).toBe(5000)
      const m2 = recordTaskCompletion(m1, 7000, 3000, 'code')
      expect(m2.categoryPerformance!.code.success).toBe(2)
      expect(m2.categoryPerformance!.code.avgDurationMs).toBe(6000)
    })

    it('tracks multiple categories independently', () => {
      let m = recordTaskCompletion(createEmptyMetrics(), 1000, 1, 'code')
      m = recordTaskCompletion(m, 2000, 2, 'research')
      expect(Object.keys(m.categoryPerformance!).sort()).toEqual(['code', 'research'])
      expect(m.categoryPerformance!.code.success).toBe(1)
      expect(m.categoryPerformance!.research.success).toBe(1)
    })
  })

  describe('recordTaskFailure', () => {
    it('increments tasksFailed', () => {
      const m = recordTaskFailure(createEmptyMetrics())
      expect(m.tasksFailed).toBe(1)
    })

    it('tracks category failure when category provided', () => {
      const m = recordTaskFailure(createEmptyMetrics(), 'research')
      expect(m.categoryPerformance!.research.fail).toBe(1)
      expect(m.categoryPerformance!.research.success).toBe(0)
    })

    it('omits categoryPerformance entry when no category given', () => {
      const m = recordTaskFailure(createEmptyMetrics())
      expect(m.categoryPerformance).toEqual({})
    })
  })

  describe('computeHistoricalScoreDelta', () => {
    it('returns 0 when no metrics exist for agent', () => {
      expect(computeHistoricalScoreDelta('missing', 'code', {})).toBe(0)
    })

    it('returns 0 when total tasks < 2 (insufficient data)', () => {
      const history: Record<string, AgentMetrics> = {
        a1: { tasksAssigned: 1, tasksCompleted: 1, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 10000, categoryPerformance: {} },
      }
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(0)
    })

    it('penalizes high failure rate (>50%) and credits speed bonus', () => {
      const history: Record<string, AgentMetrics> = {
        a1: { tasksAssigned: 4, tasksCompleted: 1, tasksFailed: 3, totalTokensUsed: 0, totalDurationMs: 10000, categoryPerformance: {} },
      }
      // -0.10 (high failure) + 0.03 (fast <30s avg) = -0.07
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(-0.07)
    })

    it('applies mid failure rate penalty (>30%)', () => {
      const history: Record<string, AgentMetrics> = {
        a1: { tasksAssigned: 10, tasksCompleted: 6, tasksFailed: 4, totalTokensUsed: 0, totalDurationMs: 600000, categoryPerformance: {} },
      }
      // 4/10 = 0.4 -> -0.05; avg 100s (not slow) ; total = -0.05
      expect(computeHistoricalScoreDelta('a1', undefined, history)).toBe(-0.05)
    })

    it('bonuses zero failure rate with >= 3 tasks plus fast speed', () => {
      const history: Record<string, AgentMetrics> = {
        a1: { tasksAssigned: 3, tasksCompleted: 3, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 60000, categoryPerformance: {} },
      }
      // +0.05 (zero failures) + 0.03 (fast) = 0.08
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(0.08)
    })

    it('penalizes slow agents (> 2min avg)', () => {
      const history: Record<string, AgentMetrics> = {
        a1: { tasksAssigned: 3, tasksCompleted: 3, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 400000, categoryPerformance: {} },
      }
      const delta = computeHistoricalScoreDelta('a1', 'code', history)
      // 0.05 (zero failures) - 0.03 (slow) = 0.02
      expect(delta).toBeCloseTo(0.02, 10)
    })

    it('caps positive delta at +0.10', () => {
      const history: Record<string, AgentMetrics> = {
        a1: {
          tasksAssigned: 5, tasksCompleted: 5, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 100000, categoryPerformance: {
            code: { success: 3, fail: 0, avgDurationMs: 20000 },
          },
        },
      }
      // base 0.05 + fast 0.03 + category 0.03 = 0.11 -> capped to 0.10
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(0.10)
    })

    it('caps negative delta at -0.15', () => {
      const history: Record<string, AgentMetrics> = {
        a1: {
          tasksAssigned: 5, tasksCompleted: 1, tasksFailed: 4, totalTokensUsed: 0, totalDurationMs: 500000, categoryPerformance: {
            code: { success: 0, fail: 3, avgDurationMs: 200000 },
          },
        },
      }
      // general fail 4/5 -> -0.10; slow -> -0.03; cat fail 3/3 -> -0.05 = -0.18 -> capped -0.15
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(-0.15)
    })

    it('applies category-specific bonus for zero-fail category', () => {
      const history: Record<string, AgentMetrics> = {
        a1: {
          tasksAssigned: 5, tasksCompleted: 5, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 100000, categoryPerformance: {
            code: { success: 3, fail: 0, avgDurationMs: 20000 },
          },
        },
      }
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(0.10)
    })

    it('applies category-specific penalty for high-fail category', () => {
      const history: Record<string, AgentMetrics> = {
        a1: {
          tasksAssigned: 5, tasksCompleted: 3, tasksFailed: 2, totalTokensUsed: 0, totalDurationMs: 100000, categoryPerformance: {
            code: { success: 1, fail: 2, avgDurationMs: 20000 },
          },
        },
      }
      const delta = computeHistoricalScoreDelta('a1', 'code', history)
      // general 2/5=0.4 -> -0.05 ; category 2/3 -> -0.05 ; total -0.10
      expect(delta).toBe(-0.10)
    })

    it('ignores category entry with < 2 samples', () => {
      const history: Record<string, AgentMetrics> = {
        a1: {
          tasksAssigned: 4, tasksCompleted: 4, tasksFailed: 0, totalTokensUsed: 0, totalDurationMs: 100000, categoryPerformance: {
            code: { success: 1, fail: 0, avgDurationMs: 20000 },
          },
        },
      }
      // base 0.05 + fast 0.03 = 0.08 (category skipped: catTotal < 2)
      expect(computeHistoricalScoreDelta('a1', 'code', history)).toBe(0.08)
    })
  })

  describe('buildAgentMetricsFromTasks', () => {
    it('counts assigned and completed tasks per agent', () => {
      const tasks: HubTask[] = [
        makeTask({ id: 't1', agentId: 'a1', status: 'done' }),
        makeTask({ id: 't2', agentId: 'a1', status: 'done' }),
        makeTask({ id: 't3', agentId: 'a1', status: 'blocked' }),
        makeTask({ id: 't4', agentId: 'a2', status: 'in_progress' }),
      ]
      const team = [makeMember({ id: 'a1' }), makeMember({ id: 'a2' })]
      const result = buildAgentMetricsFromTasks(tasks, team)
      expect(result.a1.tasksAssigned).toBe(3)
      expect(result.a1.tasksCompleted).toBe(2)
      expect(result.a1.tasksFailed).toBe(0) // blocked does NOT count as failed
      expect(result.a2.tasksAssigned).toBe(1)
      expect(result.a2.tasksCompleted).toBe(0)
    })

    it('handles tasks with no agentId by skipping them', () => {
      const tasks: HubTask[] = [
        makeTask({ id: 't1', status: 'inbox' }),
        makeTask({ id: 't2', agentId: 'a1', status: 'done' }),
      ]
      const team = [makeMember({ id: 'a1' })]
      const result = buildAgentMetricsFromTasks(tasks, team)
      expect(result.a1.tasksAssigned).toBe(1)
    })

    it('creates entries for all team members even with no tasks', () => {
      const result = buildAgentMetricsFromTasks([], [makeMember({ id: 'a1' })])
      expect(result.a1).toBeDefined()
      expect(result.a1.tasksAssigned).toBe(0)
    })
  })
})
