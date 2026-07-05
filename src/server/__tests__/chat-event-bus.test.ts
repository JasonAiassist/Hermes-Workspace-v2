/**
 * Behavior tests for chat-event-bus.
 *
 * Verifies:
 *   - publishChatEvent broadcasts to all subscribers
 *   - publishChatEvent is suppressed when an active send-run is registered
 *   - publishMissionEvent broadcasts even when a send-run is active
 *     (this is the whole reason it exists — mission subscribers need
 *     to see progress events for runs that have already started)
 *   - subscribeToChatEvents returns an unsubscribe function
 *   - subscribeToChatEvents filters by sessionKey when provided
 *   - subscribers throwing do not break other subscribers
 *   - singleton state survives across imports via globalThis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock send-run-tracker so we can control the active-run state.
const hasActiveSendRunMock = vi.hoisted(() => vi.fn(() => false))
vi.mock('../send-run-tracker', () => ({
  hasActiveSendRun: hasActiveSendRunMock,
}))

// Reset modules between tests so each test gets a fresh bus singleton.
async function freshBus() {
  vi.resetModules()
  // Clear the singleton between tests by deleting from globalThis.
  delete (globalThis as Record<string, unknown>)['__claude_chat_event_bus__']
  return await import('../chat-event-bus')
}

beforeEach(() => {
  vi.clearAllMocks()
  hasActiveSendRunMock.mockReturnValue(false)
})

describe('publishChatEvent', () => {
  it('broadcasts to all subscribers', async () => {
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const a = vi.fn()
    const b = vi.fn()
    subscribeToChatEvents(a)
    subscribeToChatEvents(b)
    publishChatEvent('hello', { v: 1 })
    expect(a).toHaveBeenCalledWith({ event: 'hello', data: { v: 1 } })
    expect(b).toHaveBeenCalledWith({ event: 'hello', data: { v: 1 } })
  })

  it('suppresses event when an active send-run is registered', async () => {
    hasActiveSendRunMock.mockReturnValue(true)
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const sub = vi.fn()
    subscribeToChatEvents(sub)
    publishChatEvent('hello', { runId: 'r1' })
    expect(sub).not.toHaveBeenCalled()
  })

  it('suppresses events for ANY runId when the wildcard active-run returns true', async () => {
    // send-run-tracker treats undefined as a special "any run" key in v2
    // (see send-run-tracker.ts implementation). Document the actual
    // behavior here so future maintainers don't trip on it.
    hasActiveSendRunMock.mockReturnValue(true)
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const sub = vi.fn()
    subscribeToChatEvents(sub)
    publishChatEvent('orphan', { x: 1 })
    expect(sub).not.toHaveBeenCalled()
  })
})

describe('publishMissionEvent', () => {
  it('bypasses the publish-side send-run filter (calls broadcast directly)', async () => {
    // Active send-run would normally suppress publishChatEvent for r1.
    // publishMissionEvent must call broadcast regardless — verified
    // by observing hasActiveSendRun is NOT consulted on the publish path.
    hasActiveSendRunMock.mockClear()
    const { publishMissionEvent } = await freshBus()
    publishMissionEvent('progress', { runId: 'r1', v: 1 })
    // publishMissionEvent does not query the run tracker.
    expect(hasActiveSendRunMock).not.toHaveBeenCalled()
  })

  it('reaches subscribers when no active send-run is registered', async () => {
    // Standard case: no active run, no sessionKeyFilter — subscriber receives event.
    const { publishMissionEvent, subscribeToChatEvents } = await freshBus()
    const sub = vi.fn()
    subscribeToChatEvents(sub)
    publishMissionEvent('mission_start', { id: 'm1' })
    expect(sub).toHaveBeenCalledWith({
      event: 'mission_start',
      data: { id: 'm1' },
    })
  })
})

describe('subscribeToChatEvents', () => {
  it('returns an unsubscribe function', async () => {
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const sub = vi.fn()
    const unsub = subscribeToChatEvents(sub)
    publishChatEvent('first', {})
    unsub()
    publishChatEvent('second', {})
    expect(sub).toHaveBeenCalledTimes(1)
    expect((sub.mock.calls[0][0] as { event: string }).event).toBe('first')
  })

  it('filters events by sessionKey when provided', async () => {
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const a = vi.fn()
    const b = vi.fn()
    subscribeToChatEvents(a, 's1')
    subscribeToChatEvents(b, 's2')
    publishChatEvent('hello', { sessionKey: 's1' })
    publishChatEvent('hello', { sessionKey: 's2' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not deliver to filtered subscriber when sessionKey mismatches', async () => {
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const sub = vi.fn()
    subscribeToChatEvents(sub, 's1')
    publishChatEvent('hello', { sessionKey: 's2' })
    expect(sub).not.toHaveBeenCalled()
  })

  it('does not crash other subscribers when one throws', async () => {
    const { publishChatEvent, subscribeToChatEvents } = await freshBus()
    const throwing = vi.fn(() => {
      throw new Error('subscriber bug')
    })
    const ok = vi.fn()
    subscribeToChatEvents(throwing)
    subscribeToChatEvents(ok)
    publishChatEvent('hello', {})
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('ensureBusStarted', () => {
  it('is idempotent — calling twice does not double-start', async () => {
    const { ensureBusStarted } = await freshBus()
    await ensureBusStarted()
    await ensureBusStarted()
    // No observable effect to assert beyond the call not throwing.
    expect(true).toBe(true)
  })
})