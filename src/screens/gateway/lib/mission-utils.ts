/**
 * Pure utility functions for the mission orchestrator.
 *
 * Extracted from use-mission-orchestrator.ts so the hook stays
 * focused on state management + effect orchestration rather than
 * data parsing / formatting.
 */

import type { HubTask, TaskStatus } from '@/screens/gateway/components/task-board'
import type { TeamMember } from '@/screens/gateway/components/team-panel'
import type { MissionProcessType } from '@/stores/mission-store'
import { FILE_OUTPUT_PROMPT } from '@/lib/file-tag-parser'
import {
  buildDependencyGraphDescription,
  buildAssignmentDescription,
} from '../../../server/planner/dispatch-order'

// ── Types ───────────────────────────────────────────────────────────

export type SessionRecord = Record<string, unknown>

export type RetryPayload = {
  tasks: HubTask[]
  messageText: string
}

export type DispatchResponse = {
  ok?: boolean
  error?: string
  message?: string
  sessionKey?: string
  runId?: string | null
}

// ── Constants ───────────────────────────────────────────────────────

/** Maximum time an agent can be "working" before we declare it timed out (ms) */
export const AGENT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/** Retry config for dispatchAgentTasks */
export const DISPATCH_MAX_RETRIES = 3
export const DISPATCH_BASE_DELAY_MS = 2_000
export const CIRCUIT_BREAKER_THRESHOLD = 3
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000

// ── Helpers ─────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readSessionId(session: SessionRecord): string {
  return readString(session.key) || readString(session.friendlyId)
}

export function readSessionName(session: SessionRecord): string {
  return (
    readString(session.label) ||
    readString(session.displayName) ||
    readString(session.title) ||
    readString(session.friendlyId) ||
    readString(session.key)
  )
}

export function readSessionLastMessage(session: SessionRecord): string {
  const record =
    session.lastMessage && typeof session.lastMessage === 'object' && !Array.isArray(session.lastMessage)
      ? (session.lastMessage as Record<string, unknown>)
      : null
  if (!record) return ''
  const directText = readString(record.text)
  if (directText) return directText
  const parts = Array.isArray(record.content) ? record.content : []
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
      return readString((part as Record<string, unknown>).text)
    })
    .filter(Boolean)
    .join(' ')
}

export function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const msg = message as Record<string, unknown>
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
  }
  return ''
}

export function classifyAgentTurnEnd(text: string | undefined | null): 'completed' | 'waiting_for_input' {
  if (!text) return 'completed'

  const trimmed = text.trim()
  if (!trimmed) return 'completed'

  const completionMarkers = [
    '[TASK_COMPLETE]', '[DONE]', '[MISSION_COMPLETE]', '[COMPLETED]',
    'TASK_COMPLETE', 'MISSION_COMPLETE',
  ]
  const upper = trimmed.toUpperCase()
  for (const marker of completionMarkers) {
    if (upper.includes(marker)) return 'completed'
  }

  const waitingMarkers = [
    '[WAITING_FOR_INPUT]', '[NEEDS_INPUT]', '[QUESTION]',
    'APPROVAL_REQUIRED:',
  ]
  for (const marker of waitingMarkers) {
    if (upper.includes(marker.toUpperCase())) return 'waiting_for_input'
  }

  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1] ?? ''
  if (/\?\s*$/.test(lastLine)) return 'waiting_for_input'
  return 'completed'
}

export function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function getAgentContext(member: TeamMember): string {
  return [
    member.roleDescription && `Role: ${member.roleDescription}`,
    member.goal && `Your goal: ${member.goal}`,
    member.backstory && `Background: ${member.backstory}`,
  ].filter(Boolean).join('\n')
}

export function buildDispatchMessage(params: {
  agentId: string
  agentTasks: HubTask[]
  member?: TeamMember
  missionGoal: string
  mode: MissionProcessType
  leadMember?: TeamMember
  workerMembers?: TeamMember[]
  allTasks?: HubTask[]
  matchedSpecialties?: string[]
}): string {
  const { agentId, agentTasks, member, missionGoal, mode, leadMember, workerMembers, allTasks, matchedSpecialties } = params
  const agentContext = member ? getAgentContext(member) : ''
  const taskList = agentTasks.map((task, index) => {
    let line = `${index + 1}. ${task.title}`
    if (task.estimatedComplexity) line += ` [${task.estimatedComplexity}]`
    if (task.requiredSkills?.length) line += ` (skills: ${task.requiredSkills.join(', ')})`
    return line
  }).join('\n')

  // Capability context
  const capabilityContext = matchedSpecialties && matchedSpecialties.length > 0
    ? `You were selected for these tasks because your specialties [${matchedSpecialties.join(', ')}] match the required skills.`
    : ''

  // Dependency graph context — ONLY for lead agents who coordinate the full mission.
  // Workers should focus exclusively on their assigned tasks to avoid scope creep
  // and file-level race conditions.
  let dependencyContext = ''
  const isLeadAgent = mode === 'hierarchical' && member && leadMember?.id === member.id
  if (isLeadAgent && allTasks && allTasks.length > 1) {
    const graphDesc = buildDependencyGraphDescription(allTasks)
    if (graphDesc) {
      dependencyContext = `\n\nMission Dependency Graph:\n${graphDesc}`
    }
  }

  // Strict scope boundary for workers — prevents agents from doing each other's work
  const scopeBoundary = isLeadAgent
    ? ''
    : mode === 'parallel'
      ? '\n\nSCOPE (PARALLEL MODE): You are working simultaneously with other team members who own their own tasks. You are ONLY responsible for the task(s) listed above. DO NOT create, modify, or mention files belonging to other agents. Only produce deliverables for YOUR assigned tasks. If your output needs to reference other files, use placeholder references only.'
      : '\n\nSCOPE: You are ONLY responsible for the task(s) listed above. Do NOT create, modify, or mention files belonging to other team members\' tasks. Focus exclusively on your assigned deliverables.'

  if (isLeadAgent) {
    const teamList = (workerMembers ?? [])
      .map((worker) => `- ${worker.name} (${worker.roleDescription})`)
      .join('\n')
    let leadBriefing = `You are the Lead Agent coordinating this mission.\n\nYour team:\n${teamList}\n\nMission Goal: ${missionGoal}\n\nYour job: Break down the goal into clear subtasks, delegate them to your team members by name, and synthesize the final result. Start by outlining the plan.`
    if (allTasks) {
      const assignmentDesc = buildAssignmentDescription(allTasks, workerMembers ?? [])
      leadBriefing += `\n\nPlanned assignments:\n${assignmentDesc}`
    }
    return [agentContext, capabilityContext, leadBriefing, dependencyContext].filter(Boolean).join('\n\n')
  }

  const prefix =
    mode === 'hierarchical' && leadMember && member && leadMember.id !== member.id
      ? `Delegated by ${leadMember.name}:\n\n`
      : ''
  let body = `${prefix}Mission Task Assignment for ${member?.name || agentId}:\n\n${taskList}\n\nMission Goal: ${missionGoal}\n\nPlease work through these tasks sequentially. Report progress on each.\n\nWhen you have completed ALL assigned tasks, end your response with [TASK_COMPLETE].${scopeBoundary}`

  if (agentTasks.some((t) => t.estimatedComplexity)) {
    body += `\n\nComplexity estimates indicate scope expectations, not time limits.`
  }

  return [agentContext, capabilityContext, body, dependencyContext, FILE_OUTPUT_PROMPT].filter(Boolean).join('\n\n')
}
