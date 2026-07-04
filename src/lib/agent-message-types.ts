/**
 * Core types for the agent-to-agent message bus.
 * Shared between client and server.
 */

export const VALID_PROFILE_NAME = /^[a-zA-Z0-9_-]+$/

export interface AgentMessage {
  id: string
  from: string
  to: string
  content: string
  timestamp: number
  /** Delivery tracking */
  deliveryStatus?: 'pending' | 'delivered' | 'failed'
  deliveryAttempts?: number
  lastDeliveryAttempt?: number
}

export interface MessageDeliverer {
  /**
   * Attempt to deliver a message to the recipient agent's gateway.
   * Returns whether delivery was accepted by the recipient.
   */
  deliver(message: AgentMessage): Promise<{ delivered: boolean; error?: string }>
}

export interface MessageBusStats {
  totalMessages: number
  pendingCount: number
  failedCount: number
  deliveredCount: number
}