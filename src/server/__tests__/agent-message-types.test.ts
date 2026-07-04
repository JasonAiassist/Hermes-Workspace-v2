import { describe, it, expect } from 'vitest'
import { type AgentMessage, type MessageDeliverer } from '../agent-message-types'

describe('agent-message-types', () => {
  it('AgentMessage shape is enforced at compile time', () => {
    const msg: AgentMessage = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1714838400000,
    }
    expect(msg.from).toBe('sage')
    expect(msg.to).toBe('jarvis')
  })

  it('MessageDeliverer interface can be implemented', async () => {
    const dummy: MessageDeliverer = {
      async deliver(message: AgentMessage): Promise<{ delivered: boolean }> {
        return { delivered: message.to === 'jarvis' }
      },
    }
    const result = await dummy.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hi',
      timestamp: 1,
    })
    expect(result.delivered).toBe(true)
  })
})