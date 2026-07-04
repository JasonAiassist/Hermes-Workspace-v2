import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentMessageStore } from '../agent-message-store'
import { type MessageDeliverer } from '../agent-message-types'

const TEST_BUS_PATH = '/tmp/test-agent-message-store.json'

const dummyDeliverer: MessageDeliverer = {
  async deliver(msg) {
    return { delivered: false }
  },
}

function createStore(deliverer?: MessageDeliverer) {
  return new AgentMessageStore({
    persistencePath: TEST_BUS_PATH,
    deliverer: deliverer ?? dummyDeliverer,
    maxRetries: 3,
    retryDelaysMs: [100, 200, 400],
    maxMessagesPerConversation: 10,
  })
}

describe('AgentMessageStore', () => {
  beforeEach(() => {
    try { require('node:fs').unlinkSync(TEST_BUS_PATH) } catch { /* ignore */ }
  })
  afterEach(() => {
    try { require('node:fs').unlinkSync(TEST_BUS_PATH) } catch { /* ignore */ }
  })

  it('sendMessage stores message and returns it with pending status', async () => {
    const bus = createStore()
    const msg = await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'hello' })
    expect(msg.from).toBe('sage')
    expect(msg.to).toBe('jarvis')
    expect(msg.deliveryStatus).toBe('pending')
    bus.shutdown()
  })

  it('getMessagesFor returns messages ordered by timestamp', async () => {
    const bus = createStore()
    await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'm1' })
    await bus.sendMessage({ from: 'jarvis', to: 'sage', content: 'm2' })
    const inbox = bus.getMessagesFor('jarvis')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].content).toBe('m1')
    bus.shutdown()
  })

  it('getConversation returns bidirectional messages', async () => {
    const bus = createStore()
    await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'hi' })
    await bus.sendMessage({ from: 'jarvis', to: 'sage', content: 'yo' })
    await bus.sendMessage({ from: 'sage', to: 'bob', content: 'ignore' })
    const conv = bus.getConversation('sage', 'jarvis')
    expect(conv).toHaveLength(2)
    bus.shutdown()
  })

  it('persists messages across restarts', async () => {
    const bus1 = createStore()
    await bus1.sendMessage({ from: 'sage', to: 'jarvis', content: 'persist' })
    bus1.shutdown()
    const bus2 = createStore()
    const inbox = bus2.getMessagesFor('jarvis')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].content).toBe('persist')
    bus2.shutdown()
  })

  it('retries failed deliveries up to maxRetries', async () => {
    const deliverer: MessageDeliverer = {
      async deliver() {
        return { delivered: false, error: 'gateway down' }
      },
    }
    const bus = createStore(deliverer)
    await bus.sendMessage({ from: 'sage', to: 'offline', content: 'retry me' })
    await new Promise((r) => setTimeout(r, 1000))
    const fetched = bus.getMessagesFor('offline')
    expect(fetched[0].deliveryAttempts).toBe(3)
    expect(fetched[0].deliveryStatus).toBe('failed')
    bus.shutdown()
  })

  it('enforces maxMessagesPerConversation by dropping oldest', async () => {
    const bus = createStore()
    for (let i = 0; i < 15; i++) {
      await bus.sendMessage({ from: 'sage', to: 'jarvis', content: `m${i}` })
    }
    const conv = bus.getConversation('sage', 'jarvis')
    expect(conv).toHaveLength(10)
    expect(conv[0].content).toBe('m5')
    bus.shutdown()
  })

  it('does not block sendMessage on delivery', async () => {
    let delivererCalled = false
    const slowDeliverer: MessageDeliverer = {
      async deliver() {
        delivererCalled = true
        await new Promise((r) => setTimeout(r, 500))
        return { delivered: true }
      },
    }
    const bus = createStore(slowDeliverer)
    const start = Date.now()
    const msg = await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'fast' })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100)
    expect(msg.deliveryStatus).toBe('pending')
    await new Promise((r) => setTimeout(r, 600))
    expect(delivererCalled).toBe(true)
    bus.shutdown()
  })

  it('rejects new messages after shutdown', async () => {
    const bus = createStore()
    bus.shutdown()
    await expect(
      bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'too late' }),
    ).rejects.toThrow('shutting down')
  })

  it('does not schedule retries after shutdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const bus = createStore({
      async deliver() {
        return { delivered: false }
      },
    })
    await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'shutdown test' })
    await vi.advanceTimersByTimeAsync(250)
    bus.shutdown()
    await vi.advanceTimersByTimeAsync(1000)
    const fetched = bus.getMessagesFor('jarvis')
    expect(fetched[0].deliveryAttempts).toBe(2)
    expect(fetched[0].deliveryStatus).toBe('pending')
    vi.useRealTimers()
  })

  it('applies retention on load and removes old messages', async () => {
    const staleTimestamp = Date.now() - 40 * 24 * 60 * 60 * 1000
    const freshTimestamp = Date.now()
    const data = [
      {
        id: 'old-msg',
        from: 'sage',
        to: 'jarvis',
        content: 'ancient',
        timestamp: staleTimestamp,
        deliveryStatus: 'delivered',
        deliveryAttempts: 1,
      },
      {
        id: 'new-msg',
        from: 'jarvis',
        to: 'sage',
        content: 'recent',
        timestamp: freshTimestamp,
        deliveryStatus: 'pending',
        deliveryAttempts: 0,
      },
    ]
    require('node:fs').writeFileSync(TEST_BUS_PATH, JSON.stringify(data), 'utf-8')

    const bus = createStore()
    const conv = bus.getConversation('sage', 'jarvis')
    expect(conv).toHaveLength(1)
    expect(conv[0].content).toBe('recent')
    bus.shutdown()
  })

  it('reports zero stats when no messages', () => {
    const bus = createStore()
    const stats = bus.getStats()
    expect(stats.totalMessages).toBe(0)
    expect(stats.pendingCount).toBe(0)
    expect(stats.failedCount).toBe(0)
    expect(stats.deliveredCount).toBe(0)
    bus.shutdown()
  })

  it('marks message as delivered when deliverer returns success', async () => {
    const successDeliverer: MessageDeliverer = {
      async deliver() {
        return { delivered: true }
      },
    }
    const bus = createStore(successDeliverer)
    await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'hi' })
    await new Promise((r) => setTimeout(r, 200))
    const fetched = bus.getMessagesFor('jarvis')
    expect(fetched[0].deliveryStatus).toBe('delivered')
    expect(fetched[0].deliveryAttempts).toBe(1)
    bus.shutdown()
  })

  it('skips conversation cap when message count is at limit', async () => {
    const bus = createStore()
    // Cap is 10; send exactly 10 messages
    for (let i = 0; i < 10; i++) {
      await bus.sendMessage({ from: 'sage', to: 'jarvis', content: `m${i}` })
    }
    const conv = bus.getConversation('sage', 'jarvis')
    expect(conv).toHaveLength(10)
    expect(conv[0].content).toBe('m0')
    expect(conv[9].content).toBe('m9')
    bus.shutdown()
  })

  it('does not schedule retry when deliverer is absent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const bus = new AgentMessageStore({
      persistencePath: TEST_BUS_PATH,
      maxRetries: 3,
      retryDelaysMs: [100, 200, 400],
      maxMessagesPerConversation: 10,
    })
    await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'no deliverer' })
    // No retry should be scheduled — message stays pending
    await vi.advanceTimersByTimeAsync(1000)
    const fetched = bus.getMessagesFor('jarvis')
    expect(fetched[0].deliveryAttempts).toBe(0)
    expect(fetched[0].deliveryStatus).toBe('pending')
    vi.useRealTimers()
    bus.shutdown()
  })
})