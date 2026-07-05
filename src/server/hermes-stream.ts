/**
 * Hermes API — chat streaming.
 *
 * SSE consumer for the FastAPI chat endpoint. Parses `event: ...` /
 * `data: ...` lines into the callback shape callers expect, handling
 * partial chunks via an internal buffer.
 */

import { authHeaders, hermesPost, resolveBaseUrl } from './hermes-api-client'

export type StreamChatEvent = {
  event: string
  data: Record<string, unknown>
}

export type StreamChatOptions = {
  signal?: AbortSignal
  onEvent: (payload: StreamChatEvent) => void
}

/**
 * Send a chat message and stream SSE events from the Hermes FastAPI
 * backend. Resolves when the stream ends (or rejects on HTTP error).
 *
 * Note: `body.model` should be the fully-resolved effective model
 * (accounting for the agent-profile → active-profile → base-config
 * inheritance chain), since FastAPI does not do that resolution.
 */
export async function streamChat(
  sessionId: string,
  body: {
    message: string
    model?: string
    system_message?: string
    attachments?: Array<Record<string, unknown>>
  },
  opts: StreamChatOptions,
  profileName?: string,
): Promise<void> {
  const base = await resolveBaseUrl(profileName)
  const res = await fetch(`${base}/api/sessions/${sessionId}/chat/stream`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes chat stream: ${res.status} ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6)
        if (dataStr === '[DONE]') continue
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>
          opts.onEvent({ event: currentEvent || 'message', data })
        } catch {
          // skip malformed JSON; chat streams occasionally emit
          // keepalive or partial lines during disconnect
        }
      }
    }
  }
}

/**
 * Non-streaming chat. Accepts either a string message (legacy) or an
 * options object with `{ message, model? }`.
 */
export async function sendChat(
  sessionId: string,
  messageOrOpts: string | { message: string; model?: string },
  model?: string,
  profileName?: string,
): Promise<Record<string, unknown>> {
  const message =
    typeof messageOrOpts === 'string' ? messageOrOpts : messageOrOpts.message
  const mdl =
    typeof messageOrOpts === 'string' ? model : messageOrOpts.model
  return hermesPost(
    `/api/sessions/${sessionId}/chat`,
    { message, model: mdl },
    profileName,
  )
}