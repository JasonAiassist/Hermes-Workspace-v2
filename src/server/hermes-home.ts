import path from 'node:path'
import os from 'node:os'

export function getHermesHome(): string {
  return process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')
}

export function getProfilesRoot(): string {
  return path.join(getHermesHome(), 'profiles')
}