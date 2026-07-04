/**
 * Pure file tag parser — no Node dependencies, safe for browser bundles.
 */

export type ExtractedFile = {
  path: string
  content: string
}

/**
 * Strip <file> tags from text, replacing them with a placeholder.
 * Use this before persisting assistant messages to keep chat history clean.
 */
export function stripFileTags(text: string): string {
  return text.replace(/<file\s+path="[^"]*">[\s\S]*?<\/file>/g, '[file attached]').trim()
}

const FILE_TAG_REGEX = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g

export function extractFileTags(content: string): ExtractedFile[] {
  const files: ExtractedFile[] = []
  let match: RegExpExecArray | null
  FILE_TAG_REGEX.lastIndex = 0
  while ((match = FILE_TAG_REGEX.exec(content)) !== null) {
    const filePath = match[1].trim()
    const fileContent = match[2]
    if (filePath) {
      files.push({ path: filePath, content: fileContent })
    }
  }
  return files
}

export const FILE_OUTPUT_PROMPT = `
CRITICAL: You MUST produce actual, working code/files as output. Do NOT just describe what you would create.

For EVERY file you create, wrap the COMPLETE file content in <file> tags like this:
<file path="relative/path/from/workspace/filename.ext">
exact file content here
</file>

You may include multiple <file> tags in a single response.
After creating all files, end your response with [TASK_COMPLETE].
`.trim()