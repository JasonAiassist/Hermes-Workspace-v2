/**
 * Agent Messaging — singleton wiring
 *
 * Exports the default AgentMessageStore backed by AgentInboxDeliverer.
 * All production code should import from here.
 */

import { AgentMessageStore } from './agent-message-store'
import { AgentInboxDeliverer } from './agent-inbox-deliverer'
import type { AgentMessage } from './agent-message-types'

const defaultBus = new AgentMessageStore({
  deliverer: new AgentInboxDeliverer(),
})

export function prepareForShutdown(): void {
  defaultBus.shutdown()
}

export async function sendAgentMessage(
  partial: Omit<AgentMessage, 'id' | 'timestamp' | 'deliveryStatus' | 'deliveryAttempts'>,
): Promise<AgentMessage> {
  return defaultBus.sendMessage(partial)
}

export function getAgentMessagesFor(profileName: string): AgentMessage[] {
  return defaultBus.getMessagesFor(profileName)
}

export function getAgentConversation(a: string, b: string): AgentMessage[] {
  return defaultBus.getConversation(a, b)
}

export function getAgentMessageStats() {
  return defaultBus.getStats()
}

// Re-export types for consumers
export type { AgentMessage, MessageDeliverer, MessageBusStats } from './agent-message-types'