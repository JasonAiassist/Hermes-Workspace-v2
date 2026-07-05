/**
 * Agent Inbox Deliverer (Option B fallback)
 *
 * Delivers inter-agent messages by injecting them into a hidden
 * `__agent_inbox__` session on the recipient's gateway via streamChat.
 *
 * This avoids requiring upstream gateway to support a native
 * `agent.receive_message` RPC endpoint.
 *
 * NOTE: This module depends on `hermes-api` (M4 in migration plan,
 * not yet ported to v2 — a stub is in place). Once M4 lands, the
 * real `listSessions` / `createSession` / `streamChat` will replace
 * the stub and the existing `vi.mock` test setup continues to work
 * against the real surface.
 */

import type { AgentMessage, MessageDeliverer } from './agent-message-types'
import { resolveGatewayHttpUrl } from './gateway-pool'
import { GatewayNotRunningError } from './gateway-errors'
import { listSessions, createSession, streamChat } from './hermes-api'

const INBOX_SESSION_KEY = '__agent_inbox__'

export class AgentInboxDeliverer implements MessageDeliverer {
  async deliver(message: AgentMessage): Promise<{ delivered: boolean; error?: string }> {
    try {
      // Verify gateway is reachable
      await resolveGatewayHttpUrl(message.to)

      // Find or create inbox session for recipient
      const sessionKey = await this.ensureInboxSession(message.to)

      // Inject message as a user turn in the inbox session
      await streamChat(
        sessionKey,
        {
          message: `[Message from ${message.from}] ${message.content}`,
        },
        { onEvent: () => { /* no-op for agent inbox injection */ } },
        message.to,
      )

      return { delivered: true }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (error instanceof GatewayNotRunningError) {
        return { delivered: false, error: `Gateway for profile '${message.to}' is not running` }
      }
      return { delivered: false, error: errMsg }
    }
  }

  private async ensureInboxSession(profileName: string): Promise<string> {
    // Use a high limit to avoid pagination issues for typical workloads.
    // If a gateway has more than 200 sessions, we fall back to creating
    // a new session (which may collide, but that's an extreme edge case).
    const sessions = await listSessions(200, 0, profileName)
    const existing = sessions.find((s: { id: string }) => s.id === INBOX_SESSION_KEY)
    if (existing) {
      return existing.id
    }

    const newSession = await createSession({ id: INBOX_SESSION_KEY }, profileName)
    return newSession.id
  }
}