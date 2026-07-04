// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('node:fs')

// Set workspace root BEFORE dynamically importing the module under test
process.env.HERMES_WORKSPACE_DIR = '/workspace'

describe('writeExtractedFiles', () => {
  let writeExtractedFiles: typeof import('../agent-file-extractor').writeExtractedFiles
  let extractFileTags: typeof import('../agent-file-extractor').extractFileTags
  const mockMkdirSync = vi.mocked(fs.mkdirSync)
  const mockWriteFileSync = vi.mocked(fs.writeFileSync)
  const mockExistsSync = vi.mocked(fs.existsSync)
  const mockReaddirSync = vi.mocked(fs.readdirSync)

  beforeEach(async () => {
    vi.clearAllMocks()
    mockMkdirSync.mockReturnValue(undefined)
    mockWriteFileSync.mockReturnValue(undefined)
    mockExistsSync.mockReturnValue(false)
    mockReaddirSync.mockReturnValue([] as any)
    const mod = await import('../agent-file-extractor')
    writeExtractedFiles = mod.writeExtractedFiles
    extractFileTags = mod.extractFileTags
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a valid file to the workspace', () => {
    const result = writeExtractedFiles(
      [{ path: 'src/utils/helper.ts', content: 'export const x = 1' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toContain('src/utils/helper.ts')
    expect(result.errors).toHaveLength(0)
    expect(mockMkdirSync).toHaveBeenCalledWith('/workspace/src/utils', { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/src/utils/helper.ts',
      'export const x = 1',
      'utf8',
    )
  })

  it('writes files to mission-scoped directory when mission context provided', () => {
    const result = writeExtractedFiles(
      [{ path: 'calculator/index.html', content: '<html></html>' }],
      { missionName: 'Calculator Web App', agentId: 'forge' },
    )
    expect(result.written).toContain('calculator/index.html')
    expect(result.errors).toHaveLength(0)
    expect(mockMkdirSync).toHaveBeenCalledWith('/workspace/Missions/calculator-web-app/calculator', { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/Missions/calculator-web-app/calculator/index.html',
      '<html></html>',
      'utf8',
    )
  })

  it('truncates mission slug to 20 characters', () => {
    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'Create a simple calculator application with add subtract multiply divide functions', agentId: 'forge' },
    )
    expect(mockMkdirSync).toHaveBeenNthCalledWith(
      1,
      '/workspace/Missions/create-a-simple-calc',
      { recursive: true },
    )
  })

  it('appends counter when mission slug collides', () => {
    mockReaddirSync.mockReturnValue(['new-mission'] as any)

    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'New Mission', agentId: 'forge' },
    )
    expect(mockMkdirSync).toHaveBeenNthCalledWith(
      1,
      '/workspace/Missions/new-mission-2',
      { recursive: true },
    )
  })

  it('increments counter until mission slug is unique', () => {
    mockReaddirSync.mockReturnValue(['new-mission', 'new-mission-2', 'new-mission-3'] as any)

    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'New Mission', agentId: 'forge' },
    )
    expect(mockMkdirSync).toHaveBeenNthCalledWith(
      1,
      '/workspace/Missions/new-mission-4',
      { recursive: true },
    )
  })

  it('does not append counter when mission slug is unique', () => {
    mockReaddirSync.mockReturnValue(['other-mission'] as any)

    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'New Mission', agentId: 'forge' },
    )
    expect(mockMkdirSync).toHaveBeenNthCalledWith(
      1,
      '/workspace/Missions/new-mission',
      { recursive: true },
    )
  })

  it('creates mission.md when mission context provided and it does not exist', () => {
    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'New Mission', agentId: 'spark' },
    )
    expect(mockExistsSync).toHaveBeenCalledWith('/workspace/Missions/new-mission/mission.md')
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/Missions/new-mission/mission.md',
      expect.stringContaining('# Mission: New Mission'),
      'utf8',
    )
  })

  it('does not overwrite existing mission.md', () => {
    mockExistsSync.mockReturnValue(true)
    writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { missionName: 'Existing Mission', agentId: 'forge' },
    )
    const missionMdCalls = mockWriteFileSync.mock.calls.filter(
      (call) => String(call[0]).includes('mission.md')
    )
    expect(missionMdCalls).toHaveLength(0)
  })

  it('rejects empty file paths', () => {
    const result = writeExtractedFiles(
      [{ path: '', content: 'oops' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid file path')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('rejects dot-only paths', () => {
    const result = writeExtractedFiles(
      [{ path: '.', content: 'oops' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(0)
    expect(result.errors[0]).toContain('Invalid file path')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('rejects double-dot paths', () => {
    const result = writeExtractedFiles(
      [{ path: '..', content: 'oops' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(0)
    expect(result.errors[0]).toContain('Invalid file path')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('blocks path traversal outside workspace', () => {
    const result = writeExtractedFiles(
      [{ path: '../../../etc/passwd', content: 'hacked' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(0)
    expect(result.errors[0]).toContain('outside workspace')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('handles mixed valid and invalid files', () => {
    const result = writeExtractedFiles(
      [
        { path: 'good.ts', content: 'ok' },
        { path: '', content: 'bad' },
        { path: 'also/good.ts', content: 'ok2' },
      ],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(2)
    expect(result.errors).toHaveLength(1)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2)
  })

  it('survives writeFileSync failures', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('Disk full')
    })
    const result = writeExtractedFiles(
      [{ path: 'test.ts', content: 'x' }],
      { baseDir: '/workspace' },
    )
    expect(result.written).toHaveLength(0)
    expect(result.errors[0]).toContain('Disk full')
  })

  it('re-exports extractFileTags', () => {
    const files = extractFileTags('<file path="a.ts">1</file>')
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('a.ts')
  })
})