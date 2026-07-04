/**
 * Agent Message Bus
 *
 * In-memory message store with JSON file persistence.
 * Supports send, receive, bidirectional conversation queries,
 * delivery retry with exponential backoff, and conversation size caps.
 *
 * Indexed by conversation key and recipient for O(1) lookups.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentMessage, MessageDeliverer, MessageBusStats } from './agent-message-types'

export class PersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'PersistenceError'
    this.cause = options?.cause
  }
}

export type AgentMessageStoreOptions = {
  persistencePath?: string
  deliverer?: MessageDeliverer
  maxRetries?: number
  retryDelaysMs?: number[]
  maxMessagesPerConversation?: number
  retentionDays?: number
}

const DEFAULT_OPTIONS: Required<Omit<AgentMessageStoreOptions, 'deliverer'>> & { deliverer?: MessageDeliverer } = {
  persistencePath: join(homedir(), '.hermes', 'agent-message-store.json'),
  maxRetries: 3,
  retryDelaysMs: [5000, 15000, 45000],
  maxMessagesPerConversation: 10000,
  retentionDays: 30,
}

function getConversationKey(a: string, b: string): string {
  return [a, b].sort().join(':')
}

export class AgentMessageStore {
  private messagesById = new Map<string, AgentMessage>()
  private conversationIndex = new Map<string, Set<string>>()
  private recipientIndex = new Map<string, Set<string>>()
  private options: Required<Omit<AgentMessageStoreOptions, 'deliverer'>> & { deliverer?: MessageDeliverer }
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private shuttingDown = false
  private retentionInterval?: ReturnType<typeof setInterval>

  constructor(options: AgentMessageStoreOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.loadFromDisk()
  }

  // ── Public API ──────────────────────────────────────────────────────────────────────────

  async sendMessage(partial: Omit<AgentMessage, 'id' | 'timestamp' | 'deliveryStatus' | 'deliveryAttempts'>): Promise<AgentMessage> {
    if (this.shuttingDown) {
      throw new Error('AgentMessageStore is shutting down')
    }

    // Start retention interval lazily on first use
    if (!this.retentionInterval) {
      this.retentionInterval = setInterval(() => this.applyRetention(), 60 * 60 * 1000)
    }

    const message: AgentMessage = {
      ...partial,
      id: randomUUID(),
      timestamp: Date.now(),
      deliveryStatus: 'pending',
      deliveryAttempts: 0,
    }

    this.addMessageToIndexes(message)
    this.enforceConversationCap(partial.from, partial.to)

    try {
      this.persistToDisk()
    } catch (err) {
      // Rollback: remove from indexes so memory stays consistent with disk
      this.removeMessageFromIndexes(message)
      throw err
    }

    // Attempt immediate delivery asynchronously — don't block HTTP response
    void this.attemptDelivery(message)

    return message
  }

  getMessagesFor(profileName: string): AgentMessage[] {
    const ids = this.recipientIndex.get(profileName)
    if (!ids || ids.size === 0) return []
    return Array.from(ids)
      .map((id) => this.messagesById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  getConversation(a: string, b: string): AgentMessage[] {
    const key = getConversationKey(a, b)
    const ids = this.conversationIndex.get(key)
    if (!ids || ids.size === 0) return []
    return Array.from(ids)
      .map((id) => this.messagesById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  getStats(): MessageBusStats {
    let pendingCount = 0
    let failedCount = 0
    let deliveredCount = 0
    for (const msg of this.messagesById.values()) {
      if (msg.deliveryStatus === 'pending') pendingCount += 1
      else if (msg.deliveryStatus === 'failed') failedCount += 1
      else if (msg.deliveryStatus === 'delivered') deliveredCount += 1
    }
    return {
      totalMessages: this.messagesById.size,
      pendingCount,
      failedCount,
      deliveredCount,
    }
  }

  shutdown(): void {
    this.shuttingDown = true
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval)
      this.retentionInterval = undefined
    }
    this.retryTimers.forEach(clearTimeout)
    this.retryTimers.clear()
    this.persistToDisk()
  }

  // ── Index management ────────────────────────────────────────────────────────────────────────

  private addMessageToIndexes(message: AgentMessage): void {
    this.messagesById.set(message.id, message)

    const convKey = getConversationKey(message.from, message.to)
    let convSet = this.conversationIndex.get(convKey)
    if (!convSet) {
      convSet = new Set()
      this.conversationIndex.set(convKey, convSet)
    }
    convSet.add(message.id)

    let recSet = this.recipientIndex.get(message.to)
    if (!recSet) {
      recSet = new Set()
      this.recipientIndex.set(message.to, recSet)
    }
    recSet.add(message.id)
  }

  private removeMessageFromIndexes(message: AgentMessage): void {
    this.messagesById.delete(message.id)

    const convKey = getConversationKey(message.from, message.to)
    const convSet = this.conversationIndex.get(convKey)
    if (convSet) {
      convSet.delete(message.id)
      if (convSet.size === 0) {
        this.conversationIndex.delete(convKey)
      }
    }

    const recSet = this.recipientIndex.get(message.to)
    if (recSet) {
      recSet.delete(message.id)
      if (recSet.size === 0) {
        this.recipientIndex.delete(message.to)
      }
    }
  }

  private rebuildIndexes(messages: AgentMessage[]): void {
    this.messagesById.clear()
    this.conversationIndex.clear()
    this.recipientIndex.clear()
    for (const msg of messages) {
      this.addMessageToIndexes(msg)
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────────────────────────────

  private async attemptDelivery(message: AgentMessage): Promise<void> {
    if (this.shuttingDown) return
    if (!this.options.deliverer) return
    if (message.deliveryStatus === 'delivered') return
    if ((message.deliveryAttempts ?? 0) >= this.options.maxRetries) {
      message.deliveryStatus = 'failed'
      this.persistToDisk()
      return
    }

    message.deliveryAttempts = (message.deliveryAttempts ?? 0) + 1
    message.lastDeliveryAttempt = Date.now()

    try {
      const result = await this.options.deliverer.deliver(message)
      if (result.delivered) {
        message.deliveryStatus = 'delivered'
      } else if ((message.deliveryAttempts ?? 0) >= this.options.maxRetries) {
        message.deliveryStatus = 'failed'
      } else {
        this.scheduleRetry(message)
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.warn(
        JSON.stringify({
          event: 'agent-message-store.delivery-error',
          messageId: message.id,
          error: errMsg,
          timestamp: new Date().toISOString(),
        }),
      )
      if ((message.deliveryAttempts ?? 0) >= this.options.maxRetries) {
        message.deliveryStatus = 'failed'
      } else {
        this.scheduleRetry(message)
      }
    }

    try {
      this.persistToDisk()
    } catch (persistErr) {
      console.error(
        '[agent-message-store] attemptDelivery persist failed:',
        persistErr instanceof Error ? persistErr.message : String(persistErr),
      )
      // Revert status to pending so the retry scheduler can attempt again
      message.deliveryStatus = 'pending'
    }
  }

  private scheduleRetry(message: AgentMessage): void {
    if (this.shuttingDown) return
    const attempts = message.deliveryAttempts ?? 0
    const delay = this.options.retryDelaysMs[Math.min(attempts - 1, this.options.retryDelaysMs.length - 1)]
    if (!delay) return

    const timer = setTimeout(() => {
      this.retryTimers.delete(message.id)
      void this.attemptDelivery(message)
    }, delay)

    this.retryTimers.set(message.id, timer)
  }

  // ── Persistence ────────────────────────────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    const path = this.options.persistencePath
    if (!existsSync(path)) {
      this.messagesById.clear()
      this.conversationIndex.clear()
      this.recipientIndex.clear()
      return
    }
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        this.rebuildIndexes(parsed as AgentMessage[])
        this.applyRetention()
        try {
          this.persistToDisk()
        } catch (persistErr) {
          console.error(
            '[agent-message-store] loadFromDisk persist failed:',
            persistErr instanceof Error ? persistErr.message : String(persistErr),
          )
        }
      }
    } catch {
      this.messagesById.clear()
      this.conversationIndex.clear()
      this.recipientIndex.clear()
    }
  }

  private persistToDisk(): void {
    const path = this.options.persistencePath
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    const tempPath = `${path}.tmp.${randomUUID()}`
    try {
      const messages = Array.from(this.messagesById.values())
      writeFileSync(tempPath, JSON.stringify(messages, null, 2), 'utf-8')
      renameSync(tempPath, path)
    } catch (err) {
      console.error(
        '[agent-message-store] persistToDisk failed:',
        err instanceof Error ? err.message : String(err),
      )
      try { unlinkSync(tempPath) } catch { /* ignore */ }
      throw new PersistenceError('Failed to persist messages to disk', { cause: err })
    }
  }

  // ── Housekeeping ────────────────────────────────────────────────────────────────────────────────

  private enforceConversationCap(from: string, to: string): void {
    const key = getConversationKey(from, to)
    const ids = this.conversationIndex.get(key)
    if (!ids || ids.size <= this.options.maxMessagesPerConversation) return

    const convMessages = Array.from(ids)
      .map((id) => this.messagesById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp)

    const excess = convMessages.length - this.options.maxMessagesPerConversation
    if (excess > 0) {
      const toRemove = convMessages.slice(0, excess)
      for (const msg of toRemove) {
        this.removeMessageFromIndexes(msg)
      }
    }
  }

  private applyRetention(): void {
    const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000
    const before = this.messagesById.size
    const toRemove: AgentMessage[] = []
    for (const msg of this.messagesById.values()) {
      if (msg.timestamp < cutoff) {
        toRemove.push(msg)
      }
    }
    for (const msg of toRemove) {
      this.removeMessageFromIndexes(msg)
    }
    if (before > this.messagesById.size) {
      console.log(
        JSON.stringify({
          event: 'agent-message-store.retention',
          cleanedCount: before - this.messagesById.size,
          remainingCount: this.messagesById.size,
          retentionDays: this.options.retentionDays,
          timestamp: new Date().toISOString(),
        }),
      )
    }
  }
}