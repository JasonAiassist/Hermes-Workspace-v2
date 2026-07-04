import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentMessageStore } from '../agent-message-store'
import { type MessageDeliverer } from '../agent-message-types'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

const TEST_BUS_PATH = '/tmp/test-agent-message-store-errors.json'

function createStore(deliverer?: MessageDeliverer) {
  return new AgentMessageStore({
    persistencePath: TEST_BUS_PATH,
    deliverer,
    maxRetries: 1,
    retryDelaysMs: [50],
    maxMessagesPerConversation: 10,
  })
}

describe('AgentMessageStore error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('throws PersistenceError and rolls back indexes when writeFileSync fails', async () => {
    const { writeFileSync } = await import('node:fs')
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('Disk full')
    })

    const bus = createStore()

    await expect(
      bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'hello' }),
    ).rejects.toThrow('Failed to persist messages to disk')

    expect(bus.getMessagesFor('jarvis')).toHaveLength(0)
    expect(bus.getConversation('sage', 'jarvis')).toHaveLength(0)

    vi.mocked(writeFileSync).mockReset()
    bus.shutdown()
  })

  it('reverts delivery status to pending when attemptDelivery persist fails', async () => {
    const { writeFileSync } = await import('node:fs')
    let writeCount = 0
    vi.mocked(writeFileSync).mockImplementation(() => {
      writeCount += 1
      if (writeCount === 2) {
        throw new Error('Disk full')
      }
    })

    const deliverer: MessageDeliverer = {
      async deliver() {
        return { delivered: true }
      },
    }

    const bus = createStore(deliverer)
    const msg = await bus.sendMessage({ from: 'sage', to: 'jarvis', content: 'hello' })

    await new Promise((r) => setTimeout(r, 200))

    expect(msg.deliveryStatus).toBe('pending')

    bus.shutdown()
  })
})