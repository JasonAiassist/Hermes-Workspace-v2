import { describe, it, expect, beforeEach } from 'vitest'
import {
  getRecord,
  resetRecord,
  getAllMonitorStates,
  getMonitorState,
  resetMonitorState,
  deleteMonitorState,
} from '../gateway-monitor-state'

describe('gateway-monitor-state', () => {
  beforeEach(() => {
    // Reset all state between tests
    const all = getAllMonitorStates()
    for (const s of all) {
      deleteMonitorState(s.profile)
    }
  })

  describe('getRecord', () => {
    it('creates a new healthy record on first access', () => {
      const rec = getRecord('sage')
      expect(rec.attempts).toBe(0)
      expect(rec.lastAttemptAt).toBe(0)
      expect(rec.state).toBe('healthy')
    })

    it('returns the same record object on subsequent calls (in-place mutation)', () => {
      const a = getRecord('sage')
      a.attempts = 5
      a.state = 'failed'
      const b = getRecord('sage')
      expect(b.attempts).toBe(5)
      expect(b.state).toBe('failed')
    })

    it('tracks separate records per profile', () => {
      const a = getRecord('sage')
      a.attempts = 3
      const b = getRecord('jarvis')
      expect(b.attempts).toBe(0)
    })
  })

  describe('resetRecord', () => {
    it('resets record to healthy state with zero attempts', () => {
      const rec = getRecord('sage')
      rec.attempts = 5
      rec.state = 'failed'
      rec.lastAttemptAt = 12345

      resetRecord('sage')

      const after = getRecord('sage')
      expect(after.attempts).toBe(0)
      expect(after.lastAttemptAt).toBe(0)
      expect(after.state).toBe('healthy')
    })
  })

  describe('deleteMonitorState', () => {
    it('removes a record from the map', () => {
      getRecord('sage')
      deleteMonitorState('sage')
      const rec = getRecord('sage')
      // After delete, getRecord returns a fresh default
      expect(rec.attempts).toBe(0)
    })

    it('is a no-op for non-existent profiles', () => {
      expect(() => deleteMonitorState('never-existed')).not.toThrow()
    })
  })

  describe('getAllMonitorStates', () => {
    it('returns empty array when no records', () => {
      expect(getAllMonitorStates()).toEqual([])
    })

    it('returns all current records', () => {
      getRecord('sage').attempts = 1
      getRecord('jarvis').attempts = 2
      getRecord('cto').attempts = 3

      const all = getAllMonitorStates()
      const profiles = all.map((s) => s.profile).sort()
      expect(profiles).toEqual(['cto', 'jarvis', 'sage'])
    })

    it('maps record fields to public state shape (lastAttemptAt nullable)', () => {
      const rec = getRecord('sage')
      rec.lastAttemptAt = 0
      const state = getMonitorState('sage')
      expect(state?.lastAttemptAt).toBeNull()
    })

    it('passes through non-zero lastAttemptAt', () => {
      getRecord('sage').lastAttemptAt = 12345
      const state = getMonitorState('sage')
      expect(state?.lastAttemptAt).toBe(12345)
    })
  })

  describe('getMonitorState', () => {
    it('returns undefined for unknown profile', () => {
      expect(getMonitorState('unknown')).toBeUndefined()
    })

    it('returns the public state shape for known profile', () => {
      const rec = getRecord('sage')
      rec.attempts = 7
      rec.state = 'restarting'
      rec.lastAttemptAt = 5000

      const state = getMonitorState('sage')
      expect(state).toEqual({
        profile: 'sage',
        state: 'restarting',
        attempts: 7,
        lastAttemptAt: 5000,
        lastProbe: undefined,
      })
    })
  })

  describe('resetMonitorState', () => {
    it('delegates to resetRecord', () => {
      getRecord('sage').attempts = 10
      resetMonitorState('sage')
      expect(getRecord('sage').attempts).toBe(0)
      expect(getRecord('sage').state).toBe('healthy')
    })
  })
})