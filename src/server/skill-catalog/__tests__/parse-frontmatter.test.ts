import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../parse-frontmatter'

describe('parseFrontmatter', () => {
  it('parses basic frontmatter with name and description', () => {
    const content = `---
name: github-pr-workflow
description: "GitHub PR lifecycle"
---

# GitHub PR Workflow
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.name).toBe('github-pr-workflow')
    expect(result.frontmatter.description).toBe('GitHub PR lifecycle')
    expect(result.body).toContain('# GitHub PR Workflow')
  })

  it('parses triggers as inline array', () => {
    const content = `---
name: debug-skill
triggers: ["bug", "error", "traceback"]
---

# Debug
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.triggers).toEqual(['bug', 'error', 'traceback'])
  })

  it('parses triggers as block array', () => {
    const content = `---
name: test-skill
triggers:
  - "keyword1"
  - keyword2
---

# Test
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.triggers).toEqual(['keyword1', 'keyword2'])
  })

  it('returns empty frontmatter when no frontmatter present', () => {
    const content = '# Just a markdown file\n\nNo frontmatter here.'
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(content)
  })

  it('returns empty frontmatter for unclosed frontmatter', () => {
    const content = `---
name: broken
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({})
  })

  it('parses depends_on array', () => {
    const content = `---
name: advanced-git
depends_on: ["github-auth", "git-basics"]
---

# Advanced Git
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.depends_on).toEqual(['github-auth', 'git-basics'])
  })

  it('parses category string', () => {
    const content = `---
name: deploy-skill
category: devops
---

# Deploy
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.category).toBe('devops')
  })

  it('handles single-quoted values', () => {
    const content = `---
name: 'my-skill'
description: 'Short desc'
---

# My Skill
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.name).toBe('my-skill')
    expect(result.frontmatter.description).toBe('Short desc')
  })

  it('parses multi-line array values', () => {
    const content = `---
name: multi-line
triggers: [
  "first",
  "second",
  "third"
]
---

# Multi
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.triggers).toEqual(['first', 'second', 'third'])
  })

  it('handles bare unquoted values', () => {
    const content = `---
name: bare
description: no quotes here
---

# Bare
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.description).toBe('no quotes here')
  })

  it('handles empty inline array', () => {
    const content = `---
name: empty-arr
triggers: []
---

# Empty
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.triggers).toEqual([])
  })

  it('ignores lines that do not match key:value pattern', () => {
    const content = `---
name: skipper
some-random-line: value
triggers: ["a"]
---

# Skip
`
    const result = parseFrontmatter(content)
    expect(result.frontmatter.name).toBe('skipper')
    expect(result.frontmatter.triggers).toEqual(['a'])
  })
})