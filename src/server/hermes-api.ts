/**
 * Hermes API HTTP client — STUB.
 *
 * Real implementation deferred to migration chunk M4 (~570 lines).
 * This stub provides the module surface that downstream code
 * (agent-inbox-deliverer, routes, etc.) imports so the v2 build
 * passes and unit tests can `vi.mock` it cleanly.
 *
 * Replace this file with the real port when M4 lands.
 */

// Type-shape stubs only — actual HTTP implementation comes in M4.
export type SessionSummary = {
  id: string
  title?: string
  updatedAt?: number
}

export type CreateSessionInput = {
  id: string
  title?: string
  model?: string
}

export type StreamChatInput = {
  message: string
  model?: string
  systemPrompt?: string
}

export type StreamChatOptions = {
  onEvent: (event: unknown) => void
}

export async function listSessions(
  _limit?: number,
  _offset?: number,
  _profileName?: string,
): Promise<SessionSummary[]> {
  throw new Error('hermes-api.listSessions not implemented (M4 deferred)')
}

export async function createSession(
  _input: CreateSessionInput,
  _profileName?: string,
): Promise<SessionSummary> {
  throw new Error('hermes-api.createSession not implemented (M4 deferred)')
}

export async function streamChat(
  _sessionKey: string,
  _input: StreamChatInput,
  _options: StreamChatOptions,
  _profileName?: string,
): Promise<void> {
  throw new Error('hermes-api.streamChat not implemented (M4 deferred)')
}