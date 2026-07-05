import { z } from 'zod'
import {
  createTaskId,
  isTaskCategory,
  type HubTask,
  type TeamMember,
  type TaskComplexity,
  type TaskCategory,
} from './types'
import { openaiChat } from '../openai-compat-api'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const plannerTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  category: z.string().min(1).max(50),
  requiredSkills: z.array(z.string().min(1).max(50)).max(10),
  estimatedComplexity: z.enum(['trivial', 'small', 'medium', 'large']).optional(),
  dependsOn: z.array(z.number().int().min(0)).max(10),
})

const plannerOutputSchema = z.object({
  summary: z.string().min(1).max(500),
  tasks: z.array(plannerTaskSchema).min(1).max(20),
})

export type PlannerOptions = {
  model?: string
  temperature?: number
  maxRetries?: number
  processType?: 'sequential' | 'parallel' | 'hierarchical'
}

export type PlannerResult = {
  tasks: HubTask[]
  summary: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function inferComplexity(description: string): TaskComplexity {
  const words = description.split(/\s+/).filter(Boolean).length
  if (words < 10) return 'trivial'
  if (words < 30) return 'small'
  if (words < 80) return 'medium'
  return 'large'
}

export function hasCycle(tasks: Array<{ dependsOn: number[] }>): boolean {
  const visited = new Set<number>()
  const recStack = new Set<number>()

  function dfs(index: number): boolean {
    visited.add(index)
    recStack.add(index)
    for (const dep of tasks[index]?.dependsOn ?? []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true
      } else if (recStack.has(dep)) {
        return true
      }
    }
    recStack.delete(index)
    return false
  }

  for (let i = 0; i < tasks.length; i++) {
    if (!visited.has(i)) {
      if (dfs(i)) return true
    }
  }
  return false
}

function buildSystemPrompt(specialties: string[], processType?: string): string {
  const processRules =
    processType === 'parallel'
      ? '- Tasks should be as independent as possible. Minimize dependencies.'
      : processType === 'hierarchical'
        ? '- The first task should be a planning/lead task that coordinates the others.'
        : '- Tasks should form a logical chain. Each task can depend on prior tasks.'

  return [
    'You are a mission planner. Decompose the user\'s goal into discrete, independently verifiable tasks.',
    '',
    'Return ONLY valid JSON in this exact shape (no markdown fences, no extra text):',
    JSON.stringify({
      summary: 'One-sentence plan overview',
      tasks: [
        {
          title: 'Task title (3-8 words)',
          description: 'What this task accomplishes and why it matters (1-3 sentences)',
          category: 'research|code|review|deploy|testing|docs|design|analysis|data|other',
          requiredSkills: ['skill1', 'skill2'],
          estimatedComplexity: 'trivial|small|medium|large',
          dependsOn: [0],
        },
      ],
    }, null, 2),
    '',
    'Rules:',
    '- A task may depend ONLY on earlier tasks (lower indices). No cycles.',
    '- Assign categories that match these agent specialties: ' + specialties.join(', ') + '.',
    '- If the goal is simple (< 3 distinct deliverables), return exactly 1 task.',
    '- Do NOT include implementation detail — only the WHAT and WHY.',
    '- Keep descriptions under 80 words.',
    '- Title must be 3-8 words.',
    '- Required skills should be 1-5 keywords.',
    processRules,
  ].join('\n')
}

function buildRetryPrompt(originalGoal: string, error: string, specialties: string[], processType?: string): string {
  return [
    'The previous plan failed validation. Please try again with simpler output.',
    `Error: ${error}`,
    '',
    'Goal: ' + originalGoal,
    '',
    'Process type: ' + (processType || 'sequential'),
    'Available specialties: ' + specialties.join(', '),
    '',
    'Return ONLY valid JSON. No markdown fences. Ensure dependsOn refers only to lower indices.',
  ].join('\n')
}

export function resolveDependencies(plannedTasks: Array<{ dependsOn: number[] }>, ids: string[]): string[][] {
  return plannedTasks.map((task) =>
    task.dependsOn
      .map((index) => ids[index])
      .filter((id): id is string => typeof id === 'string'),
  )
}

// ---------------------------------------------------------------------------
// Fallback deterministic planner
// ---------------------------------------------------------------------------

function generateFallbackPlan(goal: string, team: TeamMember[]): PlannerResult {
  const lowerGoal = goal.toLowerCase()
  const isWebApp = /web\s*app|website|html|css|javascript|js|frontend|ui|page/.test(lowerGoal)
  const isCalculator = /calculat|math|arithmetic|add|subtract|multiply|divide/.test(lowerGoal)
  const hasBackend = /backend|server|api|database|db|express|fastapi|flask/.test(lowerGoal)
  const hasTests = /test|spec|jest|vitest|pytest/.test(lowerGoal)
  const hasDocs = /doc|readme|markdown|guide/.test(lowerGoal)

  const tasks: HubTask[] = []
  let index = 0
  const now = Date.now()

  const addTask = (title: string, description: string, category: TaskCategory, requiredSkills: string[], complexity: TaskComplexity, dependsOn: number[] = []) => {
    const id = createTaskId()
    const depIds = dependsOn.map((i) => tasks[i]?.id).filter((id): id is string => typeof id === 'string')
    const member = team.length > 0 ? team[index % team.length] : undefined
    tasks.push({
      id,
      title,
      description,
      priority: index === 0 ? 'high' : 'normal',
      status: member ? 'assigned' : 'inbox',
      agentId: member?.id,
      createdAt: now + index,
      updatedAt: now + index,
      category,
      requiredSkills,
      estimatedComplexity: complexity,
      dependencies: depIds,
    })
    index++
  }

  if (isCalculator && isWebApp) {
    addTask(
      'Create HTML calculator structure',
      'Build the HTML layout with a display screen, number buttons (0-9), operator buttons (+, -, *, /), equals, and clear buttons. Ensure semantic markup and accessibility.',
      'code',
      ['html', 'frontend'],
      'small',
    )
    addTask(
      'Style calculator with CSS',
      'Implement a modern dark theme with responsive design. Use CSS Grid or Flexbox for button layout. Add hover/focus states and ensure mobile compatibility.',
      'design',
      ['css', 'frontend', 'responsive-design'],
      'small',
      [0],
    )
    addTask(
      'Implement calculator logic in JavaScript',
      'Write JavaScript to handle button clicks, perform arithmetic operations (+, -, *, /), manage calculator state, and update the display. Handle edge cases like division by zero.',
      'code',
      ['javascript', 'frontend'],
      'medium',
      [0, 1],
    )
    if (hasTests) {
      addTask(
        'Write unit tests for calculator logic',
        'Create tests for all arithmetic operations and edge cases. Ensure the calculator produces correct results for various inputs.',
        'testing',
        ['javascript', 'testing'],
        'small',
        [2],
      )
    }
    addTask(
      'Polish and finalize calculator app',
      'Review the complete application for bugs, UI inconsistencies, and performance issues. Add keyboard support and ensure cross-browser compatibility.',
      'review',
      ['html', 'css', 'javascript'],
      'small',
      hasTests ? [3] : [2],
    )
  } else if (isWebApp) {
    addTask(
      'Set up project structure and HTML',
      'Create the foundational HTML structure and project organization. Include necessary meta tags, viewport settings, and script/style links.',
      'code',
      ['html', 'frontend'],
      'small',
    )
    addTask(
      'Implement UI styling with CSS',
      'Build responsive, visually appealing styles. Consider the requested theme and ensure the layout works across device sizes.',
      'design',
      ['css', 'frontend'],
      'small',
      [0],
    )
    addTask(
      'Implement core application logic',
      'Write the JavaScript (or framework code) that powers the application functionality described in the goal.',
      'code',
      ['javascript', 'frontend'],
      'medium',
      [0, 1],
    )
    if (hasBackend) {
      addTask(
        'Build backend API',
        'Create server endpoints to support the frontend. Handle data persistence, business logic, and API design.',
        'code',
        ['backend', 'api-design'],
        'medium',
        [2],
      )
    }
    if (hasTests) {
      addTask(
        'Write tests',
        'Add unit and integration tests to verify core functionality and catch regressions.',
        'testing',
        ['testing'],
        'small',
        [hasBackend ? 3 : 2],
      )
    }
    addTask(
      'Final review and polish',
      'Review the complete application, fix any bugs, optimize performance, and ensure all requirements from the goal are met.',
      'review',
      ['frontend'],
      'small',
      [tasks.length - 1],
    )
  } else {
    // Generic fallback
    addTask(
      'Analyze requirements and plan approach',
      'Review the goal, identify key deliverables, and determine the best approach to accomplish the mission.',
      'analysis',
      ['planning'],
      'small',
    )
    addTask(
      'Implement core solution',
      'Build the primary deliverable described in the goal. Focus on correctness and completeness.',
      'code',
      team.flatMap((m) => m.specialties ?? []).filter(Boolean).slice(0, 3),
      'medium',
      [0],
    )
    addTask(
      'Review and finalize',
      'Review the work against the original goal, fix any issues, and ensure quality.',
      'review',
      ['review'],
      'small',
      [1],
    )
  }

  return {
    tasks,
    summary: `Plan: ${tasks.length} tasks to build ${goal.slice(0, 80)}`,
  }
}

export async function planMission(
  goal: string,
  team: TeamMember[],
  options: PlannerOptions = {},
): Promise<PlannerResult> {
  if (!goal.trim()) {
    throw new Error('Goal is required')
  }

  const specialties = team.flatMap((m) => m.specialties ?? []).filter(Boolean)
  const allSpecialties = specialties.length > 0 ? specialties : ['general']

  const messages = [
    { role: 'system', content: buildSystemPrompt(allSpecialties, options.processType) },
    { role: 'user', content: goal.trim() },
  ]

  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? 1, 2))
  let lastRaw = ''
  let lastError = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // v2: route through the gateway (CLAUDE_API) by NOT overriding baseUrl.
      // The fork's hardcoded local Qwen server (:8022) is not part of v2;
      // v2's openaiChat resolves the gateway URL and default model itself.
      const content =
        attempt === 0
          ? await openaiChat(messages, {
              model: options.model,
              temperature: options.temperature ?? 0.3,
              stream: false,
            })
          : await openaiChat(
              [
                {
                  role: 'system',
                  content: buildRetryPrompt(goal.trim(), lastError, allSpecialties, options.processType),
                },
                { role: 'user', content: goal.trim() },
              ],
              {
                model: options.model,
                temperature: 0.2,
                stream: false,
              },
            )

      lastRaw = content

      // Strip markdown fences if the LLM ignored instructions
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      const jsonText = jsonMatch ? jsonMatch[0] : content

      const parsed = JSON.parse(jsonText) as unknown
      const validated = plannerOutputSchema.parse(parsed)

      // Cycle detection
      const tasksWithDeps = validated.tasks.map((t) => ({ dependsOn: t.dependsOn ?? [] }))
      if (hasCycle(tasksWithDeps)) {
        throw new Error('Cyclic dependencies detected in planned tasks')
      }

      // Generate stable IDs
      const ids = validated.tasks.map(() => createTaskId())
      const dependencyLists = resolveDependencies(tasksWithDeps, ids)

      const now = Date.now()
      const tasks: HubTask[] = validated.tasks.map((task, index) => {
        const member = team.length > 0 ? team[index % team.length] : undefined
        return {
          id: ids[index]!,
          title: task.title,
          description: task.description,
          priority: index === 0 ? 'high' : 'normal',
          status: member ? 'assigned' : 'inbox',
          agentId: member?.id,
          createdAt: now + index,
          updatedAt: now + index,
          category: isTaskCategory(task.category) ? task.category : 'other',
          requiredSkills: task.requiredSkills,
          estimatedComplexity: task.estimatedComplexity ?? inferComplexity(task.description),
          dependencies: dependencyLists[index],
        }
      })

      return { tasks, summary: validated.summary }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === maxRetries) {
        break
      }
    }
  }

  // Fallback to deterministic planner when LLM is unavailable or misconfigured
  return generateFallbackPlan(goal, team)
}

export class PlannerError extends Error {
  constructor(message: string, public rawOutput: string) {
    super(message)
    this.name = 'PlannerError'
  }
}

export { plannerOutputSchema, plannerTaskSchema }
