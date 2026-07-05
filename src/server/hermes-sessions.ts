/**
 * Hermes API — sessions & messages.
 *
 * Session CRUD + message listing + search + fork + conversion helpers
 * (HermesMessage → ChatMessage, HermesSession → SessionSummary).
 *
 * Routing: defaults to FastAPI gateway (`/api/sessions/*`). Non-default
 * profiles transparently use the local in-memory session store because
 * the gateway singleton does not scope sessions by profile.
 */

import {
  getLocalSession,
  listLocalSessions,
  ensureLocalSession,
  updateLocalSessionTitle,
  deleteLocalSession,
  getLocalMessages,
} from './local-session-store'

import {
  hermesDelete,
  hermesGet,
  hermesPatch,
  hermesPost,
  withProfile,
  type HermesMessage,
  type HermesSession,
} from './hermes-api-client'

// ── Local-session bridge ──────────────────────────────────────────────

/**
 * Non-default profiles use the local in-memory store because the
 * gateway singleton does not scope sessions per profile. This helper
 * encapsulates the routing decision.
 */
export function shouldUseLocalStore(profileName?: string): boolean {
  return Boolean(profileName && profileName !== 'default')
}

export function localSessionToHermes(
  ls: ReturnType<typeof getLocalSession>,
): HermesSession {
  if (!ls) throw new Error('Local session not found')
  return {
    id: ls.id,
    title: ls.title,
    model: ls.model,
    started_at: Math.floor(ls.createdAt / 1000),
    last_active: Math.floor(ls.updatedAt / 1000),
    message_count: ls.messageCount,
    preview: null,
  }
}

// ── Sessions ─────────────────────────────────────────────────────────

export async function listSessions(
  limit = 50,
  offset = 0,
  profileName?: string,
): Promise<HermesSession[]> {
  return withProfile(profileName, async () => {
    if (shouldUseLocalStore(profileName)) {
      const prefix = `profile:${profileName}:`
      return listLocalSessions()
        .filter((ls) => ls.id.startsWith(prefix))
        .slice(offset, offset + limit)
        .map(localSessionToHermes)
    }
    const resp = await hermesGet<{ items: HermesSession[]; total: number }>(
      `/api/sessions?limit=${limit}&offset=${offset}`,
      profileName,
    )
    return resp.items
  })
}

export async function getSession(
  sessionId: string,
  profileName?: string,
): Promise<HermesSession> {
  return withProfile(profileName, async () => {
    if (shouldUseLocalStore(profileName)) {
      const ls = getLocalSession(sessionId)
      if (!ls) throw new Error('Session not found')
      return localSessionToHermes(ls)
    }
    const resp = await hermesGet<{ session: HermesSession }>(
      `/api/sessions/${sessionId}`,
      profileName,
    )
    return resp.session
  })
}

export async function createSession(
  opts: { id?: string; title?: string; model?: string } = {},
  profileName?: string,
): Promise<HermesSession> {
  return withProfile(profileName, async () => {
    if (shouldUseLocalStore(profileName)) {
      const id = opts.id || crypto.randomUUID()
      const prefixedId = id.startsWith('profile:')
        ? id
        : `profile:${profileName}:${id}`
      ensureLocalSession(prefixedId, opts.model || undefined)
      if (opts.title) updateLocalSessionTitle(prefixedId, opts.title)
      const ls = getLocalSession(prefixedId)
      if (!ls) throw new Error('Failed to create local session')
      return localSessionToHermes(ls)
    }
    const resp = await hermesPost<{ session: HermesSession }>(
      '/api/sessions',
      opts,
      profileName,
    )
    return resp.session
  })
}

export async function updateSession(
  sessionId: string,
  updates: { title?: string },
  profileName?: string,
): Promise<HermesSession> {
  if (shouldUseLocalStore(profileName)) {
    if (updates.title) updateLocalSessionTitle(sessionId, updates.title)
    const ls = getLocalSession(sessionId)
    if (!ls) throw new Error('Session not found')
    return localSessionToHermes(ls)
  }
  const resp = await hermesPatch<{ session: HermesSession }>(
    `/api/sessions/${sessionId}`,
    updates,
    profileName,
  )
  return resp.session
}

export async function deleteSession(
  sessionId: string,
  profileName?: string,
): Promise<void> {
  return withProfile(profileName, async () => {
    if (shouldUseLocalStore(profileName)) {
      deleteLocalSession(sessionId)
      return
    }
    await hermesDelete(`/api/sessions/${sessionId}`, profileName)
  })
}

// ── Messages ─────────────────────────────────────────────────────────

export async function getMessages(
  sessionId: string,
  profileName?: string,
): Promise<HermesMessage[]> {
  return withProfile(profileName, async () => {
    if (shouldUseLocalStore(profileName)) {
      return getLocalMessages(sessionId).map((m) => ({
        id: m.id as unknown as number,
        session_id: sessionId,
        role: m.role,
        content: m.content,
        timestamp: Math.floor(m.timestamp / 1000),
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        tool_name: m.toolName,
      }))
    }
    const resp = await hermesGet<{ items: HermesMessage[]; total: number }>(
      `/api/sessions/${sessionId}/messages`,
      profileName,
    )
    return resp.items
  })
}

// ── Search / fork ────────────────────────────────────────────────────

export async function searchSessions(
  query: string,
  limit = 20,
  profileName?: string,
): Promise<{ query?: string; count?: number; results: unknown[] }> {
  return withProfile(profileName, async () =>
    hermesGet(
      `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      profileName,
    ),
  )
}

export async function forkSession(
  sessionId: string,
  profileName?: string,
): Promise<{ session: HermesSession; forked_from: string }> {
  return hermesPost(`/api/sessions/${sessionId}/fork`, undefined, profileName)
}

// ── Conversion helpers (Hermes → Chat format) ────────────────────────

/**
 * Convert a HermesMessage to the ChatMessage format the frontend
 * expects. Accepts either parsed arrays from FastAPI or legacy JSON
 * strings for `tool_calls`.
 */
export function toChatMessage(
  msg: HermesMessage,
  options?: { historyIndex?: number },
): Record<string, unknown> {
  let toolCalls: unknown[] | undefined
  if (Array.isArray(msg.tool_calls)) {
    toolCalls = msg.tool_calls
  } else if (msg.tool_calls && typeof msg.tool_calls === 'string') {
    try {
      toolCalls = JSON.parse(msg.tool_calls)
    } catch {
      toolCalls = undefined
    }
  }

  const content: Array<Record<string, unknown>> = []
  const streamToolCallsArr: Array<Record<string, unknown>> = []
  if (msg.role === 'assistant' && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const record = tc as Record<string, unknown>
      const fn = record.function as Record<string, unknown> | undefined
      const toolCallId =
        (record.id as string) || `tc-${Math.random().toString(36).slice(2, 8)}`
      const toolName =
        (fn?.name as string | undefined) ||
        (record.name as string | undefined) ||
        'tool'
      const toolArgs = fn?.arguments
      streamToolCallsArr.push({
        id: toolCallId,
        name: toolName,
        args: toolArgs,
        phase: 'complete',
      })
      content.push({
        type: 'toolCall',
        id: toolCallId,
        name: toolName,
        arguments:
          toolArgs && typeof toolArgs === 'object'
            ? (toolArgs as Record<string, unknown>)
            : undefined,
        partialJson: typeof toolArgs === 'string' ? toolArgs : undefined,
      })
    }
  }

  if (msg.role === 'tool') {
    content.push({
      type: 'tool_result',
      toolCallId: msg.tool_call_id,
      toolName: msg.tool_name,
      text: msg.content || '',
    })
  }

  if (msg.content && msg.role !== 'tool') {
    content.push({ type: 'text', text: msg.content })
  }

  return {
    id: `msg-${msg.id}`,
    role: msg.role,
    content,
    text: msg.content || '',
    timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    createdAt: msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined,
    sessionKey: msg.session_id,
    ...(typeof options?.historyIndex === 'number'
      ? { __historyIndex: options.historyIndex }
      : {}),
    ...(streamToolCallsArr.length > 0
      ? { streamToolCalls: streamToolCallsArr }
      : {}),
  }
}

/**
 * Convert a HermesSession to the session summary shape the frontend
 * chat/sidebar lists expect.
 */
export function toSessionSummary(
  session: HermesSession,
): Record<string, unknown> {
  const startedAt = session.started_at ? session.started_at * 1000 : Date.now()
  const lastActive = session.last_active ? session.last_active * 1000 : null
  const endedAt = session.ended_at ? session.ended_at * 1000 : null
  const updatedAt =
    lastActive ?? endedAt ?? startedAt
  return {
    key: session.id,
    friendlyId: session.id,
    kind: 'chat',
    status: session.ended_at ? 'ended' : 'idle',
    model: session.model || '',
    label: session.title || '',
    title: session.title || undefined,
    derivedTitle: session.title || session.preview || undefined,
    preview: session.preview || undefined,
    tokenCount: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    message_count: session.message_count ?? 0,
    tool_call_count: session.tool_call_count ?? 0,
    messageCount: session.message_count ?? 0,
    toolCallCount: session.tool_call_count ?? 0,
    cost: 0,
    createdAt: startedAt,
    startedAt,
    updatedAt,
    usage: {
      promptTokens: session.input_tokens ?? 0,
      completionTokens: session.output_tokens ?? 0,
      totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    },
  }
}