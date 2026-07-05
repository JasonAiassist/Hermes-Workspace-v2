import { describe, it, expect, vi } from 'vitest'

vi.mock('../agent-message-store', () => ({
  AgentMessageStore: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      id: 'msg-1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 12345,
      deliveryStatus: 'pending',
    }),
    getMessagesFor: vi.fn().mockReturnValue([{ id: 'msg-1', content: 'hello' }]),
    getConversation: vi.fn().mockReturnValue([{ id: 'msg-1' }, { id: 'msg-2' }]),
    getStats: vi.fn().mockReturnValue({ totalMessages: 1, pendingCount: 1, failedCount: 0 }),
    shutdown: vi.fn(),
  })),
}))

import {
  sendAgentMessage,
  getAgentMessagesFor,
  getAgentConversation,
  getAgentMessageStats,
  prepareForShutdown,
} from '../agent-messaging'

describe('agent-messaging convenience API', () => {
  it('sendAgentMessage delegates to bus', async () => {
    const msg = await sendAgentMessage({ from: 'sage', to: 'jarvis', content: 'hi' })
    expect(msg.from).toBe('sage')
    expect(msg.to).toBe('jarvis')
  })

  it('getAgentMessagesFor delegates to bus', () => {
    const msgs = getAgentMessagesFor('jarvis')
    expect(msgs).toHaveLength(1)
  })

  it('getAgentConversation delegates to bus', () => {
    const conv = getAgentConversation('sage', 'jarvis')
    expect(conv).toHaveLength(2)
  })

  it('getAgentMessageStats delegates to bus', () => {
    const stats = getAgentMessageStats()
    expect(stats.totalMessages).toBe(1)
  })

  it('prepareForShutdown delegates to bus', () => {
    expect(() => prepareForShutdown()).not.toThrow()
  })
})