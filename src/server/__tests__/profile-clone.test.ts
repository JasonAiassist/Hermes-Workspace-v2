import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyMemory } from '../profile-clone'

const mockCpSync = vi.hoisted(() => vi.fn())
const mockMkdirSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockReaddirSync = vi.hoisted(() => vi.fn())
const mockStatSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  cpSync: mockCpSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
}))

describe('copyMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when source memories dir does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    const result = copyMemory('/src', '/dst')
    expect(result).toEqual({ copied: false, sizeMb: 0 })
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('copies memory directory and reports size', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/src/memories') return true
      return false
    })
    mockReaddirSync.mockReturnValue([
      { name: 'session1.json', isDirectory: () => false, isFile: () => true },
    ])
    mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024 } as any) // 2MB

    const result = copyMemory('/src', '/dst')
    expect(mockMkdirSync).toHaveBeenCalledWith('/dst/memory', { recursive: true })
    expect(mockCpSync).toHaveBeenCalledWith('/src/memories', '/dst/memory', {
      recursive: true,
      force: true,
    })
    expect(result.copied).toBe(true)
    expect(result.sizeMb).toBe(2)
  })

  it('includes warning when size exceeds threshold', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/src/memories') return true
      return false
    })
    mockReaddirSync.mockReturnValue([
      { name: 'big.json', isDirectory: () => false, isFile: () => true },
    ])
    mockStatSync.mockReturnValue({ size: 150 * 1024 * 1024 } as any) // 150MB

    const result = copyMemory('/src', '/dst')
    expect(result.warning).toContain('150MB')
    expect(result.warning).toContain('threshold: 100MB')
  })

  it('handles nested directories', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/src/memories') return true
      return false
    })
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/src/memories') {
        return [
          { name: 'nested', isDirectory: () => true, isFile: () => false },
          { name: 'root.json', isDirectory: () => false, isFile: () => true },
        ]
      }
      if (dir === '/src/memories/nested') {
        return [
          { name: 'deep.json', isDirectory: () => false, isFile: () => true },
        ]
      }
      return []
    })
    mockStatSync.mockReturnValue({ size: 1024 * 1024 } as any) // 1MB each

    const result = copyMemory('/src', '/dst')
    expect(result.copied).toBe(true)
    expect(result.sizeMb).toBeGreaterThanOrEqual(1)
  })

  it('survives cpSync error', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/src/memories') return true
      return false
    })
    mockReaddirSync.mockReturnValue([])
    mockStatSync.mockReturnValue({ size: 0 } as any)
    mockCpSync.mockImplementation(() => {
      throw new Error('permission denied')
    })

    expect(() => copyMemory('/src', '/dst')).toThrow('permission denied')
  })
})
