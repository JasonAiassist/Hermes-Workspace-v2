import { describe, it, expect } from 'vitest'
import { extractFileTags, FILE_OUTPUT_PROMPT, stripFileTags } from '../file-tag-parser'

describe('extractFileTags', () => {
  it('returns empty array for plain text', () => {
    expect(extractFileTags('Hello world')).toEqual([])
  })

  it('extracts a single file tag', () => {
    const content = 'Some explanation\n<file path="index.html"><html></html></file>\nMore text'
    const result = extractFileTags(content)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('index.html')
    expect(result[0].content).toBe('<html></html>')
  })

  it('extracts multiple file tags', () => {
    const content = `
<file path="a.css">body { color: red; }</file>
<file path="b.js">console.log(1)</file>
    `
    const result = extractFileTags(content)
    expect(result).toHaveLength(2)
    expect(result[0].path).toBe('a.css')
    expect(result[1].path).toBe('b.js')
  })

  it('handles nested directory paths', () => {
    const content = '<file path="src/components/App.tsx">export default () => {}</file>'
    const result = extractFileTags(content)
    expect(result[0].path).toBe('src/components/App.tsx')
  })

  it('handles multiline content', () => {
    const content = `<file path="main.py">
def hello():
    return "world"
</file>`
    const result = extractFileTags(content)
    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('def hello():')
  })

  it('ignores malformed tags', () => {
    const content = '<file>no path</file> and <file path="">empty</file>'
    expect(extractFileTags(content)).toEqual([])
  })

  it('resets regex state between calls', () => {
    const content = '<file path="x.txt">a</file>'
    expect(extractFileTags(content)).toHaveLength(1)
    expect(extractFileTags(content)).toHaveLength(1)
  })
})

describe('FILE_OUTPUT_PROMPT', () => {
  it('contains file tag instructions', () => {
    expect(FILE_OUTPUT_PROMPT).toContain('<file path=')
    expect(FILE_OUTPUT_PROMPT).toContain('content here')
  })
})

describe('stripFileTags', () => {
  it('strips a single file tag', () => {
    const text = 'Here is code: <file path="x.ts">const x = 1</file> Done'
    expect(stripFileTags(text)).toBe('Here is code: [file attached] Done')
  })

  it('strips multiple file tags', () => {
    const text = '<file path="a.ts">1</file> <file path="b.ts">2</file>'
    expect(stripFileTags(text)).toBe('[file attached] [file attached]')
  })

  it('returns plain text unchanged', () => {
    expect(stripFileTags('hello world')).toBe('hello world')
  })

  it('handles multiline file content', () => {
    const text = '<file path="x.ts">line1\nline2</file>'
    expect(stripFileTags(text)).toBe('[file attached]')
  })

  it('handles empty string', () => {
    expect(stripFileTags('')).toBe('')
  })

  it('trims surrounding whitespace after stripping', () => {
    const text = '  <file path="a.ts">x</file>  '
    expect(stripFileTags(text)).toBe('[file attached]')
  })
})