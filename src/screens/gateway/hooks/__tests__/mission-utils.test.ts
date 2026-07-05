import { describe, it, expect } from 'vitest'
import {
  readString,
  readSessionId,
  readSessionName,
  readSessionLastMessage,
  extractTextFromMessage,
  classifyAgentTurnEnd,
  createId,
  getAgentContext,
  buildDispatchMessage,
  sleep,
  AGENT_TIMEOUT_MS,
  DISPATCH_MAX_RETRIES,
  DISPATCH_BASE_DELAY_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_COOLDOWN_MS,
} from '../../lib/mission-utils'
import type { HubTask } from '@/screens/gateway/components/task-board'
import type { TeamMember } from '@/screens/gateway/components/team-panel'

describe('constants', () => {
  it('exports expected values', () => {
    expect(AGENT_TIMEOUT_MS).toBe(600_000)
    expect(DISPATCH_MAX_RETRIES).toBe(3)
    expect(DISPATCH_BASE_DELAY_MS).toBe(2_000)
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(3)
    expect(CIRCUIT_BREAKER_COOLDOWN_MS).toBe(60_000)
  })
})

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })
})

describe('readString', () => {
  it('trims string values', () => {
    expect(readString('  hi  ')).toBe('hi')
  })
  it('returns empty for non-strings', () => {
    expect(readString(42)).toBe('')
    expect(readString(null)).toBe('')
    expect(readString(undefined)).toBe('')
    expect(readString({})).toBe('')
    expect(readString([])).toBe('')
  })
})

describe('readSessionId', () => {
  it('prefers key over friendlyId', () => {
    expect(readSessionId({ key: 'k1', friendlyId: 'f1' })).toBe('k1')
    expect(readSessionId({ friendlyId: 'f1' })).toBe('f1')
    expect(readSessionId({})).toBe('')
  })
})

describe('readSessionName', () => {
  it('tries label, displayName, title, friendlyId, key in order', () => {
    expect(readSessionName({ label: 'L' })).toBe('L')
    expect(readSessionName({ displayName: 'D' })).toBe('D')
    expect(readSessionName({ title: 'T' })).toBe('T')
    expect(readSessionName({ friendlyId: 'F' })).toBe('F')
    expect(readSessionName({ key: 'K' })).toBe('K')
    expect(readSessionName({})).toBe('')
  })
})

describe('readSessionLastMessage', () => {
  it('extracts direct text', () => {
    expect(readSessionLastMessage({ lastMessage: { text: 'hello' } })).toBe('hello')
  })
  it('extracts text from content array', () => {
    expect(
      readSessionLastMessage({
        lastMessage: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      }),
    ).toBe('a b')
  })
  it('returns empty when lastMessage is missing or not an object', () => {
    expect(readSessionLastMessage({})).toBe('')
    expect(readSessionLastMessage({ lastMessage: 'string' })).toBe('')
    expect(readSessionLastMessage({ lastMessage: [1, 2] })).toBe('')
  })
})

describe('extractTextFromMessage', () => {
  it('extracts string content', () => {
    expect(extractTextFromMessage({ content: 'hello' })).toBe('hello')
  })
  it('extracts text blocks from content array', () => {
    expect(
      extractTextFromMessage({ content: [{ type: 'text', text: 'a' }, { type: 'tool', text: 'b' }] }),
    ).toBe('a')
  })
  it('returns empty for non-objects', () => {
    expect(extractTextFromMessage(null)).toBe('')
    expect(extractTextFromMessage('string')).toBe('')
    expect(extractTextFromMessage(undefined)).toBe('')
  })
})

describe('classifyAgentTurnEnd', () => {
  it('returns completed for completion markers', () => {
    expect(classifyAgentTurnEnd('[TASK_COMPLETE]')).toBe('completed')
    expect(classifyAgentTurnEnd('[DONE]')).toBe('completed')
    expect(classifyAgentTurnEnd('[MISSION_COMPLETE]')).toBe('completed')
  })
  it('returns waiting_for_input for input markers', () => {
    expect(classifyAgentTurnEnd('[WAITING_FOR_INPUT]')).toBe('waiting_for_input')
    expect(classifyAgentTurnEnd('[NEEDS_INPUT]')).toBe('waiting_for_input')
    expect(classifyAgentTurnEnd('[QUESTION]')).toBe('waiting_for_input')
    expect(classifyAgentTurnEnd('APPROVAL_REQUIRED: yes')).toBe('waiting_for_input')
  })
  it('returns waiting_for_input when last line ends with ?', () => {
    expect(classifyAgentTurnEnd('some text\nWhat do you think?')).toBe('waiting_for_input')
  })
  it('returns completed for null/empty/whitespace', () => {
    expect(classifyAgentTurnEnd(null)).toBe('completed')
    expect(classifyAgentTurnEnd('')).toBe('completed')
    expect(classifyAgentTurnEnd('   ')).toBe('completed')
  })
  it('returns completed for normal text', () => {
    expect(classifyAgentTurnEnd('Task is done.')).toBe('completed')
  })
})

describe('createId', () => {
  it('creates an ID with the given prefix', () => {
    const id = createId('task')
    expect(id.startsWith('task-')).toBe(true)
  })
  it('creates unique IDs', () => {
    const a = createId('x')
    const b = createId('x')
    expect(a).not.toBe(b)
  })
})

describe('getAgentContext', () => {
  it('builds context from member fields', () => {
    const member: TeamMember = {
      id: '1',
      name: 'Forge',
      modelId: 'kimi',
      roleDescription: 'Coder',
      goal: 'Build stuff',
      backstory: 'Expert dev',
      status: 'available',
    } as TeamMember
    const ctx = getAgentContext(member)
    expect(ctx).toContain('Role: Coder')
    expect(ctx).toContain('Your goal: Build stuff')
    expect(ctx).toContain('Background: Expert dev')
  })
  it('returns empty string when all fields are empty', () => {
    const member = { id: '1', name: '', modelId: '', roleDescription: '', goal: '', backstory: '', status: 'available' } as TeamMember
    expect(getAgentContext(member)).toBe('')
  })
})

describe('buildDispatchMessage', () => {
  const member: TeamMember = {
    id: 'forge',
    name: 'Forge',
    modelId: 'kimi',
    roleDescription: 'Senior engineer',
    goal: 'Ship code',
    backstory: 'Expert',
    status: 'available',
  } as TeamMember

  const tasks: HubTask[] = [
    { id: 't1', title: 'Build API', status: 'pending', agentId: 'forge', priority: 'normal', description: '' },
    { id: 't2', title: 'Write tests', status: 'pending', agentId: 'forge', priority: 'normal', description: '' },
  ] as HubTask[]

  it('builds a worker dispatch message in sequential mode', () => {
    const msg = buildDispatchMessage({
      agentId: 'forge',
      agentTasks: tasks,
      member,
      missionGoal: 'Ship the product',
      mode: 'sequential',
    })
    expect(msg).toContain('Build API')
    expect(msg).toContain('Write tests')
    expect(msg).toContain('Ship the product')
    expect(msg).toContain('[TASK_COMPLETE]')
    expect(msg).toContain('SCOPE:')
  })

  it('builds a lead agent briefing in hierarchical mode', () => {
    const worker: TeamMember = {
      id: 'worker1', name: 'Worker', modelId: 'kimi',
      roleDescription: 'Helper', goal: '', backstory: '', status: 'available',
    } as TeamMember
    const msg = buildDispatchMessage({
      agentId: 'forge',
      agentTasks: tasks,
      member,
      missionGoal: 'Ship the product',
      mode: 'hierarchical',
      leadMember: member,
      workerMembers: [worker],
      allTasks: tasks,
    })
    expect(msg).toContain('Lead Agent')
    expect(msg).toContain('Worker')
    expect(msg).toContain('Planned assignments:')
  })

  it('includes delegation prefix for workers in hierarchical mode', () => {
    const worker: TeamMember = {
      id: 'w1', name: 'Worker', modelId: 'kimi',
      roleDescription: '', goal: '', backstory: '', status: 'available',
    } as TeamMember
    const msg = buildDispatchMessage({
      agentId: 'w1',
      agentTasks: [tasks[0]],
      member: worker,
      missionGoal: 'G',
      mode: 'hierarchical',
      leadMember: member,
    })
    expect(msg).toContain('Delegated by Forge:')
  })

  it('includes parallel mode scope boundary', () => {
    const msg = buildDispatchMessage({
      agentId: 'forge',
      agentTasks: tasks,
      member,
      missionGoal: 'G',
      mode: 'parallel',
    })
    expect(msg).toContain('PARALLEL MODE')
  })

  it('includes matched specialties when provided', () => {
    const msg = buildDispatchMessage({
      agentId: 'forge',
      agentTasks: tasks,
      member,
      missionGoal: 'G',
      mode: 'sequential',
      matchedSpecialties: ['code', 'testing'],
    })
    expect(msg).toContain('[code, testing]')
  })

  it('includes complexity and skills in task list', () => {
    const complexTasks: HubTask[] = [
      {
        id: 't1', title: 'Hard task', status: 'pending', agentId: 'f',
        priority: 'normal', description: '',
        estimatedComplexity: 'high', requiredSkills: ['python', 'docker'],
      } as HubTask,
    ]
    const msg = buildDispatchMessage({
      agentId: 'f', agentTasks: complexTasks, member, missionGoal: 'G', mode: 'sequential',
    })
    expect(msg).toContain('[high]')
    expect(msg).toContain('python, docker')
  })
})