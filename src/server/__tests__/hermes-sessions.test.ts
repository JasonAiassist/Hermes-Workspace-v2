/**
 * Behavior tests for hermes-sessions.
 *
 * Verifies:
 *   - shouldUseLocalStore routing (default vs non-default profiles)
 *   - listSessions / getSession / createSession route to gateway for
 *     default profile, local store for non-default
 *   - createSession prefixes non-default IDs with "profile:<name>:"
 *   - getMessages normalizes local store timestamps to seconds
 *   - searchSessions + forkSession hit the right endpoints
 *   - toChatMessage handles parsed arrays AND legacy JSON strings for tool_calls
 *   - toSessionSummary computes token counts and timestamps correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../local-session-store', () => ({
  listLocalSessions: vi.fn(),
  getLocalSession: vi.fn(),
  ensureLocalSession: vi.fn(),
  updateLocalSessionTitle: vi.fn(),
  deleteLocalSession: vi.fn(),
  getLocalMessages: vi.fn(),
}))

vi.mock('../hermes-api-client', () => ({
  hermesGet: vi.fn(),
  hermesPost: vi.fn(),
  hermesPatch: vi.fn(),
  hermesDelete: vi.fn(),
  withProfile: vi.fn(),
}))

import {
  listLocalSessions,
  getLocalSession,
  ensureLocalSession,
  updateLocalSessionTitle,
  deleteLocalSession,
  getLocalMessages,
} from '../local-session-store'
import {
  hermesGet,
  hermesPost,
  hermesPatch,
  hermesDelete,
  withProfile,
} from '../hermes-api-client'

import {
  createSession,
  deleteSession,
  forkSession,
  getMessages,
  getSession,
  listSessions,
  localSessionToHermes,
  searchSessions,
  shouldUseLocalStore,
  toChatMessage,
  toSessionSummary,
  updateSession,
} from '../hermes-sessions'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: withProfile just runs the function inline.
  vi.mocked(withProfile).mockImplementation(
    async (_name, fn) => fn() as Promise<unknown>,
  )
  // Override crypto.randomUUID to a stable value so ID assertions
  // don't drift across Node versions.
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── shouldUseLocalStore ───────────────────────────────────────────────

describe('shouldUseLocalStore', () => {
  it('returns false when no profileName', () => {
    expect(shouldUseLocalStore()).toBe(false)
    expect(shouldUseLocalStore(undefined)).toBe(false)
  })
  it('returns false for default profile', () => {
    expect(shouldUseLocalStore('default')).toBe(false)
  })
  it('returns true for any non-default profile', () => {
    expect(shouldUseLocalStore('sage')).toBe(true)
    expect(shouldUseLocalStore('jarvis')).toBe(true)
  })
})

// ── localSessionToHermes ──────────────────────────────────────────────

describe('localSessionToHermes', () => {
  it('throws when input is null', () => {
    expect(() => localSessionToHermes(null)).toThrow('Local session not found')
  })

  it('maps millisecond timestamps to seconds', () => {
    const ls = {
      id: 'sage-1',
      title: 'hello',
      model: 'kimi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
      messageCount: 3,
    } as ReturnType<typeof getLocalSession>
    const h = localSessionToHermes(ls)
    expect(h.id).toBe('sage-1')
    expect(h.started_at).toBe(1_700_000_000)
    expect(h.last_active).toBe(1_700_000_500)
    expect(h.message_count).toBe(3)
    expect(h.preview).toBeNull()
  })
})

// ── listSessions ──────────────────────────────────────────────────────

describe('listSessions', () => {
  it('routes to gateway for default profile', async () => {
    vi.mocked(hermesGet).mockResolvedValue({
      items: [{ id: 's1' }],
      total: 1,
    })
    const out = await listSessions(10, 0, 'default')
    expect(out).toEqual([{ id: 's1' }])
    expect(hermesGet).toHaveBeenCalledWith(
      '/api/sessions?limit=10&offset=0',
      'default',
    )
  })

  it('uses local store for non-default profiles', async () => {
    vi.mocked(listLocalSessions).mockReturnValue([
      {
        id: 'profile:sage:s1',
        title: 'a',
        model: null,
        createdAt: 1_000_000_000,
        updatedAt: 1_000_000_000,
        messageCount: 0,
      },
      {
        id: 'profile:jarvis:s2',
        title: 'b',
        model: null,
        createdAt: 1_000_000_000,
        updatedAt: 1_000_000_000,
        messageCount: 0,
      },
    ] as any)
    const out = await listSessions(50, 0, 'sage')
    expect(out.map((s) => s.id)).toEqual(['profile:sage:s1'])
  })

  it('applies limit + offset to filtered local results', async () => {
    vi.mocked(listLocalSessions).mockReturnValue(
      Array.from({ length: 30 }, (_, i) => ({
        id: `profile:sage:s${i}`,
        title: null,
        model: null,
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
      })) as any,
    )
    const out = await listSessions(5, 10, 'sage')
    expect(out).toHaveLength(5)
    expect(out[0].id).toBe('profile:sage:s10')
  })
})

// ── getSession ────────────────────────────────────────────────────────

describe('getSession', () => {
  it('routes to gateway for default profile', async () => {
    vi.mocked(hermesGet).mockResolvedValue({ session: { id: 's1' } })
    const out = await getSession('s1', 'default')
    expect(out).toEqual({ id: 's1' })
    expect(hermesGet).toHaveBeenCalledWith('/api/sessions/s1', 'default')
  })

  it('uses local store for non-default profiles', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:s1',
      title: 't',
      model: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    const out = await getSession('profile:sage:s1', 'sage')
    expect(out.id).toBe('profile:sage:s1')
  })

  it('throws when local session not found', async () => {
    vi.mocked(getLocalSession).mockReturnValue(null)
    await expect(getSession('missing', 'sage')).rejects.toThrow('not found')
  })
})

// ── createSession ─────────────────────────────────────────────────────

describe('createSession', () => {
  it('routes to gateway for default profile', async () => {
    vi.mocked(hermesPost).mockResolvedValue({ session: { id: 'new' } })
    const out = await createSession({ title: 'x' }, 'default')
    expect(out).toEqual({ id: 'new' })
    expect(hermesPost).toHaveBeenCalledWith('/api/sessions', { title: 'x' }, 'default')
  })

  it('uses local store for non-default profiles, prefixing the id', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:my-id',
      title: 't',
      model: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    const out = await createSession({ id: 'my-id', title: 't' }, 'sage')
    expect(out.id).toBe('profile:sage:my-id')
    expect(ensureLocalSession).toHaveBeenCalledWith('profile:sage:my-id', undefined)
    expect(updateLocalSessionTitle).toHaveBeenCalledWith('profile:sage:my-id', 't')
  })

  it('keeps an already-prefixed id as-is', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:already-prefixed',
      title: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    const out = await createSession({ id: 'profile:sage:already-prefixed' }, 'sage')
    expect(out.id).toBe('profile:sage:already-prefixed')
    expect(ensureLocalSession).toHaveBeenCalledWith(
      'profile:sage:already-prefixed',
      undefined,
    )
  })

  it('generates a UUID when no id provided', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:00000000-0000-4000-8000-000000000001',
      title: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    const out = await createSession({}, 'sage')
    expect(out.id).toBe('profile:sage:00000000-0000-4000-8000-000000000001')
  })

  it('passes model through to ensureLocalSession', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:00000000-0000-4000-8000-000000000001',
      title: null,
      model: 'kimi',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    await createSession({ model: 'kimi' }, 'sage')
    expect(ensureLocalSession).toHaveBeenCalledWith('profile:sage:00000000-0000-4000-8000-000000000001', 'kimi')
  })
})

// ── updateSession ─────────────────────────────────────────────────────

describe('updateSession', () => {
  it('routes to gateway for default profile', async () => {
    vi.mocked(hermesPatch).mockResolvedValue({ session: { id: 's1', title: 'new' } })
    const out = await updateSession('s1', { title: 'new' }, 'default')
    expect(out.title).toBe('new')
    expect(hermesPatch).toHaveBeenCalledWith(
      '/api/sessions/s1',
      { title: 'new' },
      'default',
    )
  })

  it('updates title in local store for non-default profiles', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'profile:sage:s1',
      title: 'new',
      model: null,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
    } as any)
    await updateSession('profile:sage:s1', { title: 'new' }, 'sage')
    expect(updateLocalSessionTitle).toHaveBeenCalledWith(
      'profile:sage:s1',
      'new',
    )
  })
})

// ── deleteSession ─────────────────────────────────────────────────────

describe('deleteSession', () => {
  it('routes to gateway for default profile', async () => {
    await deleteSession('s1', 'default')
    expect(hermesDelete).toHaveBeenCalledWith('/api/sessions/s1', 'default')
  })

  it('uses local store for non-default profiles', async () => {
    await deleteSession('profile:sage:s1', 'sage')
    expect(deleteLocalSession).toHaveBeenCalledWith('profile:sage:s1')
    expect(hermesDelete).not.toHaveBeenCalled()
  })
})

// ── getMessages ───────────────────────────────────────────────────────

describe('getMessages', () => {
  it('routes to gateway for default profile', async () => {
    vi.mocked(hermesGet).mockResolvedValue({
      items: [{ id: 1, role: 'user' }],
      total: 1,
    })
    const out = await getMessages('s1', 'default')
    expect(out).toEqual([{ id: 1, role: 'user' }])
  })

  it('uses local store for non-default profiles, converting ms to s', async () => {
    vi.mocked(getLocalMessages).mockReturnValue([
      {
        id: 'msg-1',
        role: 'user',
        content: 'hi',
        timestamp: 1_700_000_000_000,
        toolCalls: undefined,
        toolCallId: undefined,
        toolName: undefined,
      },
    ] as any)
    const out = await getMessages('profile:sage:s1', 'sage')
    expect(out).toHaveLength(1)
    expect(out[0].timestamp).toBe(1_700_000_000)
    expect(out[0].session_id).toBe('profile:sage:s1')
  })
})

// ── searchSessions + forkSession ──────────────────────────────────────

describe('searchSessions', () => {
  it('encodes query and forwards profileName', async () => {
    vi.mocked(hermesGet).mockResolvedValue({ results: [] })
    await searchSessions('hello world', 25, 'sage')
    expect(hermesGet).toHaveBeenCalledWith(
      '/api/sessions/search?q=hello%20world&limit=25',
      'sage',
    )
  })
})

describe('forkSession', () => {
  it('POSTs to /fork endpoint', async () => {
    vi.mocked(hermesPost).mockResolvedValue({ session: { id: 'forked' }, forked_from: 'orig' })
    const out = await forkSession('orig', 'sage')
    expect(out).toEqual({ session: { id: 'forked' }, forked_from: 'orig' })
    expect(hermesPost).toHaveBeenCalledWith('/api/sessions/orig/fork', undefined, 'sage')
  })
})

// ── toChatMessage ─────────────────────────────────────────────────────

describe('toChatMessage', () => {
  it('converts a user text message', () => {
    const out = toChatMessage({
      id: 1,
      session_id: 's1',
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_000,
    })
    expect(out.role).toBe('user')
    expect(out.text).toBe('hi')
    expect(out.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(out.timestamp).toBe(1_700_000_000_000)
  })

  it('parses legacy JSON-string tool_calls', () => {
    const out = toChatMessage({
      id: 2,
      session_id: 's1',
      role: 'assistant',
      content: 'calling tool',
      timestamp: 0,
      tool_calls: JSON.stringify([
        { id: 'tc1', function: { name: 'search', arguments: { q: 'x' } } },
      ]),
    })
    const c = out.content as Array<Record<string, unknown>>
    expect(c.some((b) => b.type === 'toolCall')).toBe(true)
  })

  it('falls back to undefined when tool_calls JSON is malformed', () => {
    const out = toChatMessage({
      id: 3,
      session_id: 's1',
      role: 'assistant',
      content: 'hmm',
      timestamp: 0,
      tool_calls: '{not json',
    })
    expect(out.content).toEqual([{ type: 'text', text: 'hmm' }])
  })

  it('skips tool_calls when value is neither array nor string', () => {
    const out = toChatMessage({
      id: 3,
      session_id: 's1',
      role: 'assistant',
      content: 'hmm',
      timestamp: 0,
      tool_calls: 42 as unknown as Array<unknown>, // number, not array or string
    })
    expect(out.content).toEqual([{ type: 'text', text: 'hmm' }])
  })

  it('uses partialJson when tool arguments are a string', () => {
    const out = toChatMessage({
      id: 4,
      session_id: 's1',
      role: 'assistant',
      content: 'hi',
      timestamp: 0,
      tool_calls: [
        { id: 'tc1', function: { name: 'search', arguments: '{"q":"x"}' } },
      ],
    })
    const c = out.content as Array<Record<string, unknown>>
    const tc = c.find((b) => b.type === 'toolCall') as Record<string, unknown>
    expect(tc.partialJson).toBe('{"q":"x"}')
    expect(tc.arguments).toBeUndefined()
  })

  it('generates a synthetic toolCallId when neither id nor function.name present', () => {
    const out = toChatMessage({
      id: 5,
      session_id: 's1',
      role: 'assistant',
      content: 'hi',
      timestamp: 0,
      tool_calls: [{}],
    })
    const c = out.content as Array<Record<string, unknown>>
    const tc = c.find((b) => b.type === 'toolCall') as Record<string, unknown>
    expect(typeof tc.id).toBe('string')
    expect((tc.id as string).startsWith('tc-')).toBe(true)
    expect(tc.name).toBe('tool')
  })

  it('renders tool_result content blocks for role=tool', () => {
    const out = toChatMessage({
      id: 4,
      session_id: 's1',
      role: 'tool',
      content: 'output',
      timestamp: 0,
      tool_call_id: 'tc1',
      tool_name: 'search',
    })
    const c = out.content as Array<Record<string, unknown>>
    expect(c.some((b) => b.type === 'tool_result')).toBe(true)
  })

  it('attaches historyIndex when provided', () => {
    const out = toChatMessage(
      {
        id: 5,
        session_id: 's1',
        role: 'user',
        content: 'hi',
        timestamp: 0,
      },
      { historyIndex: 7 },
    )
    expect(out.__historyIndex).toBe(7)
  })
})

// ── toSessionSummary ──────────────────────────────────────────────────

describe('toSessionSummary', () => {
  it('derives timestamps, token counts and friendly fields', () => {
    const out = toSessionSummary({
      id: 's1',
      title: 'My session',
      model: 'kimi',
      started_at: 1_700_000_000,
      ended_at: null,
      last_active: 1_700_000_500,
      message_count: 4,
      tool_call_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      preview: 'preview text',
    })
    expect(out.key).toBe('s1')
    expect(out.label).toBe('My session')
    expect(out.tokenCount).toBe(150)
    expect(out.messageCount).toBe(4)
    expect(out.toolCallCount).toBe(2)
    expect(out.startedAt).toBe(1_700_000_000_000)
    expect(out.updatedAt).toBe(1_700_000_500_000)
    expect(out.status).toBe('idle')
    expect((out.usage as Record<string, number>).totalTokens).toBe(150)
  })

  it('marks ended sessions as ended', () => {
    const out = toSessionSummary({
      id: 's1',
      ended_at: 1_700_001_000,
    })
    expect(out.status).toBe('ended')
  })
})