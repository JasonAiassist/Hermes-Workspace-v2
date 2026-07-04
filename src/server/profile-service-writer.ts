/**
 * Generate systemd user-service files for persistent profile gateways.
 *
 * Each persistent profile gets its own `hermes-gateway-<name>.service`
 * matching the canonical SAGE architecture:
 *   - ExecStart: <hermes-bin> gateway run
 *   - Environment: HERMES_HOME, API_SERVER_ENABLED, API_SERVER_PORT
 *   - Simple Restart=on-failure with RestartSec=5
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { resolveHermesBinary } from './hermes-agent'
import { getProfileHermesHome } from './gateway-registry'

export type ServiceWriteResult =
  | { success: true; servicePath: string }
  | { success: false; error: string }

/**
 * Write a systemd user-service unit for a profile gateway.
 * Matches the canonical SAGE service architecture.
 */
export function writeProfileSystemdService(profileName: string): ServiceWriteResult {
  try {
    const hermesHome = getProfileHermesHome(profileName)
    const hermesBin = resolveHermesBinary()

    if (!hermesBin) {
      return {
        success: false,
        error: 'Hermes CLI binary not found at ~/.local/bin/hermes or ~/.hermes/bin/hermes',
      }
    }

    // Read profile .env for API_SERVER_PORT
    const envPath = path.join(hermesHome, '.env')
    if (!fs.existsSync(envPath)) {
      return { success: false, error: `Profile .env not found at ${envPath}` }
    }
    const envRaw = fs.readFileSync(envPath, 'utf-8')
    const envLines = envRaw
      .split('\n')
      .filter((line: string) => line.trim() && !line.trim().startsWith('#'))

    const envMap: Record<string, string> = {}
    for (const line of envLines) {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }

    const apiServerPort = envMap.API_SERVER_PORT
    if (!apiServerPort) {
      return {
        success: false,
        error: 'API_SERVER_PORT not found in profile .env',
      }
    }

    const unit = `[Unit]
Description=Hermes ${profileName} Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${hermesHome}
Environment=HERMES_HOME=${hermesHome}
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_PORT=${apiServerPort}
EnvironmentFile=-${envPath}
ExecStart=${hermesBin} gateway run --replace
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`

    const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(systemdDir, { recursive: true })

    const servicePath = path.join(
      systemdDir,
      `hermes-gateway-${profileName}.service`,
    )
    fs.writeFileSync(servicePath, unit, 'utf-8')

    // Notify systemd to pick up the new unit file
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' })
    } catch {
      // ignore — daemon-reload may fail in containers or test environments
    }

    return { success: true, servicePath }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Remove the systemd service file for a profile, if it exists.
 */
export function removeProfileSystemdService(profileName: string): void {
  const servicePath = path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    `hermes-gateway-${profileName}.service`,
  )
  if (fs.existsSync(servicePath)) {
    fs.unlinkSync(servicePath)
  }
}

/**
 * Check whether a systemd service file exists for a profile.
 */
export function hasSystemdService(profileName: string): boolean {
  const servicePath = path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    `hermes-gateway-${profileName}.service`,
  )
  return fs.existsSync(servicePath)
}
