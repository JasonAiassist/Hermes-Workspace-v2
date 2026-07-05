import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../hermes-api', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock('../gateway-pool', () => ({
  resolveGatewayHttpUrl: vi.fn().mockResolvedValue('http://127.0.0.1:8642'),
}))

import { AgentInboxDeliverer } from '../agent-inbox-deliverer'
import { GatewayNotRunningError } from '../gateway-errors'
import { listSessions, createSession, streamChat } from '../hermes-api'
import { resolveGatewayHttpUrl } from '../gateway-pool'

describe('AgentInboxDeliverer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default happy-path gateway resolution after tests that
    // intentionally fail this; clearAllMocks only clears call history.
    vi.mocked(resolveGatewayHttpUrl).mockResolvedValue('http://127.0.0.1:8642')
  })

  it('delivers via existing inbox session', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: '__agent_inbox__', title: 'Inbox', updatedAt: Date.now() },
    ] as any)

    const deliverer = new AgentInboxDeliverer()
    const result = await deliverer.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1,
    })

    expect(result.delivered).toBe(true)
    expect(createSession).not.toHaveBeenCalled()
    expect(streamChat).toHaveBeenCalled()
  })

  it('creates inbox session if none exists', async () => {
    vi.mocked(listSessions).mockResolvedValue([])
    vi.mocked(createSession).mockResolvedValue({ id: '__agent_inbox__' } as any)

    const deliverer = new AgentInboxDeliverer()
    const result = await deliverer.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1,
    })

    expect(result.delivered).toBe(true)
    expect(createSession).toHaveBeenCalledWith({ id: '__agent_inbox__' }, 'jarvis')
    expect(streamChat).toHaveBeenCalled()
  })

  it('returns failure when gateway is not running', async () => {
    const { resolveGatewayHttpUrl } = await import('../gateway-pool')
    vi.mocked(resolveGatewayHttpUrl).mockRejectedValue(
      new GatewayNotRunningError('jarvis'),
    )

    const deliverer = new AgentInboxDeliverer()
    const result = await deliverer.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1,
    })

    expect(result.delivered).toBe(false)
    expect(result.error).toContain('not running')
  })

  it('returns failure when streamChat throws a generic Error', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: '__agent_inbox__', title: 'Inbox', updatedAt: Date.now() },
    ] as any)
    vi.mocked(streamChat).mockRejectedValue(new Error('network blip'))

    const deliverer = new AgentInboxDeliverer()
    const result = await deliverer.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1,
    })

    expect(result.delivered).toBe(false)
    expect(result.error).toBe('network blip')
  })

  it('returns failure when streamChat throws a non-Error value', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: '__agent_inbox__', title: 'Inbox', updatedAt: Date.now() },
    ] as any)
    vi.mocked(streamChat).mockRejectedValue('raw-string-error')

    const deliverer = new AgentInboxDeliverer()
    const result = await deliverer.deliver({
      id: '1',
      from: 'sage',
      to: 'jarvis',
      content: 'hello',
      timestamp: 1,
    })

    expect(result.delivered).toBe(false)
    expect(result.error).toBe('raw-string-error')
  })
})