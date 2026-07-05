/**
 * Agent pause endpoint — acknowledge pause toggle for an agent session.
 *
 * This endpoint is intentionally a no-op: pause/resume is managed
 * client-side in the Conductor and Agent Hub. It exists so UI
 * components can call a uniform API. When Hermes gateway gains native
 * session pause, this route can forward to the backend.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { extractProfileName } from '../../lib/session-keys'

export const Route = createFileRoute('/api/agent-pause')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as {
            sessionKey?: string
            pause?: boolean
          }
          const sessionKey = (body.sessionKey || '').trim()
          const pause = Boolean(body.pause)

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey is required' },
              { status: 400 },
            )
          }

          // Extract profile hint for logging / future backend support.
          const profile =
            extractProfileName(sessionKey) ??
            request.headers.get('X-Hermes-Profile') ??
            undefined

          // No-op: pause state is client-side only.
          return json({ ok: true, sessionKey, profile, clientSideOnly: true })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to pause agent',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})