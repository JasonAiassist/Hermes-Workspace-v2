/**
 * Read workspace-scoped persistence config from a profile's config.yaml.
 *
 * Persistent profiles have a systemd service (always-on / start-on-demand).
 * Allocated profiles route through another profile's gateway and do not
 * spawn their own process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { getHermesHome, getProfilesRoot } from './hermes-home'
import { readYamlConfig } from './config-reader'

export type ProfileWorkspaceConfig = {
  persistent: boolean
  allocatedTo?: string
}

export function getProfileWorkspaceConfig(
  profileName: string,
): ProfileWorkspaceConfig {
  const normalized = (profileName.trim() || 'default').toLowerCase()
  const profilePath =
    normalized === 'default'
      ? getHermesHome()
      : path.join(getProfilesRoot(), normalized)
  const configPath = path.join(profilePath, 'config.yaml')

  if (!fs.existsSync(configPath)) {
    return { persistent: false }
  }

  try {
    const config = readYamlConfig(configPath)
    const workspace = config.workspace as Record<string, unknown> | undefined
    const persistence = workspace?.persistence as Record<string, unknown> | undefined

    return {
      persistent: persistence?.persistent === true,
      allocatedTo:
        typeof persistence?.allocatedTo === 'string'
          ? persistence.allocatedTo
          : undefined,
    }
  } catch {
    return { persistent: false }
  }
}