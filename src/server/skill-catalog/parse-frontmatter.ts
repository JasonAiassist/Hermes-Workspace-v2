/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expected format:
 *   ---
 *   name: skill-name
 *   description: "Short description"
 *   triggers: ["keyword1", "keyword2"]
 *   category: devops
 *   depends_on: ["other-skill"]
 *   ---
 *
 * Returns parsed fields + the body text after frontmatter.
 */

export type ParsedFrontmatter = {
  name?: string
  description?: string
  triggers?: string[]
  category?: string
  depends_on?: string[]
  [key: string]: unknown
}

export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter
  body: string
} {
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed }
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return { frontmatter: {}, body: trimmed }
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trim()

  const frontmatter = parseYamlBlock(yamlBlock)
  return { frontmatter, body }
}

function parseYamlBlock(yaml: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {}
  const lines = yaml.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (!match) {
      i++
      continue
    }

    const key = match[1]
    const value = match[2].trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      // Inline array: ["a", "b"]
      result[key] = parseInlineArray(value)
    } else if (value.startsWith('[') && !value.endsWith(']')) {
      // Multi-line array
      const { items, nextIndex } = parseMultilineArray(lines, i)
      result[key] = items
      i = nextIndex
      continue
    } else if (value === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('- ')) {
      // Block array starting on next line
      const { items, nextIndex } = parseBlockArray(lines, i + 1)
      result[key] = items
      i = nextIndex
      continue
    } else if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1)
    } else if (value.startsWith("'") && value.endsWith("'")) {
      result[key] = value.slice(1, -1)
    } else {
      result[key] = value
    }

    i++
  }

  return result
}

function parseInlineArray(value: string): string[] {
  const inner = value.slice(1, -1)
  if (!inner.trim()) return []
  return inner
    .split(',')
    .map((s) => s.trim())
    .map((s) => {
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1)
      }
      return s
    })
    .filter(Boolean)
}

function parseMultilineArray(lines: string[], startIndex: number): { items: string[]; nextIndex: number } {
  const items: string[] = []
  // Strip the key and opening '[' from the first line
  const firstLine = lines[startIndex]
  const openBracket = firstLine.indexOf('[')
  let buffer = openBracket >= 0 ? firstLine.slice(openBracket + 1).trim() : firstLine.trim()
  let i = startIndex + 1

  while (i < lines.length && !buffer.endsWith(']')) {
    buffer += ' ' + lines[i].trim()
    i++
  }

  // Strip trailing ']' before parsing inline
  if (buffer.endsWith(']')) {
    buffer = buffer.slice(0, -1)
  }

  return { items: parseInlineArray(buffer), nextIndex: i }
}

function parseBlockArray(lines: string[], startIndex: number): { items: string[]; nextIndex: number } {
  const items: string[] = []
  let i = startIndex

  while (i < lines.length && lines[i].trim().startsWith('- ')) {
    const value = lines[i].trim().slice(2).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      items.push(value.slice(1, -1))
    } else {
      items.push(value)
    }
    i++
  }

  return { items, nextIndex: i }
}