/**
 * Profile name validation shared across profile lifecycle routes.
 */

const VALID_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function isValidProfileName(name: string, allowDefault = false): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (!VALID_NAME_RE.test(trimmed)) return false
  if (!allowDefault && trimmed.toLowerCase() === 'default') return false
  return true
}

export type ValidateProfileNameResult =
  | { valid: true; name: string }
  | { valid: false; error: string }

/**
 * Validate a profile name for filesystem safety and UI consistency.
 * Returns the trimmed name on success, or an error message on failure.
 */
export function validateProfileName(raw: unknown, allowDefault = false): ValidateProfileNameResult {
  if (typeof raw !== 'string') {
    return { valid: false, error: 'Profile name is required' }
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return { valid: false, error: 'Profile name is required' }
  }

  if (!VALID_NAME_RE.test(trimmed)) {
    return { valid: false, error: 'Invalid profile name' }
  }

  if (!allowDefault && trimmed.toLowerCase() === 'default') {
    return { valid: false, error: '"default" is a reserved profile name' }
  }

  return { valid: true, name: trimmed }
}