import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { planMission, PlannerError } from '../../server/planner/mission-planner'
import type { TeamMember } from '../../server/planner/types'

type PlanMissionBody = {
  goal?: unknown
  team?: unknown
  processType?: unknown
  options?: unknown
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readTeam(value: unknown): TeamMember[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TeamMember => {
    if (!item || typeof item !== 'object') return false
    const obj = item as Record<string, unknown>
    return typeof obj.id === 'string' && typeof obj.name === 'string'
  })
}

function readProcessType(value: unknown): 'sequential' | 'parallel' | 'hierarchical' {
  if (value === 'sequential' || value === 'parallel' || value === 'hierarchical') return value
  return 'sequential'
}

function readOptions(value: unknown): { model?: string; temperature?: number; maxRetries?: number } {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  return {
    model: typeof obj.model === 'string' ? obj.model : undefined,
    temperature: typeof obj.temperature === 'number' ? obj.temperature : undefined,
    maxRetries: typeof obj.maxRetries === 'number' ? obj.maxRetries : undefined,
  }
}

export const Route = createFileRoute('/api/plan-mission')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json().catch(() => ({}))) as PlanMissionBody
          const goal = readOptionalString(body.goal)
          const team = readTeam(body.team)
          const processType = readProcessType(body.processType)
          const options = readOptions(body.options)

          if (!goal) {
            return json({ ok: false, error: 'goal is required' }, { status: 400 })
          }

          const result = await planMission(goal, team, { ...options, processType })

          return json({
            ok: true,
            tasks: result.tasks,
            summary: result.summary,
            cycleWarning: false,
            fromCache: false,
          })
        } catch (error) {
          if (error instanceof PlannerError) {
            return json(
              {
                ok: false,
                error: error.message,
                rawOutput: error.rawOutput,
              },
              { status: 502 },
            )
          }
          const message = error instanceof Error ? error.message : String(error)
          return json({ ok: false, error: message }, { status: 500 })
        }
      },
    },
  },
})
