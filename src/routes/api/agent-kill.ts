/**
 * Agent kill endpoint — terminate an active agent session.
 *
 * Receives { sessionKey } and deletes the underlying gateway session.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  deleteSession,
  ensureGatewayProbed,
} from '../../server/hermes-api'
import {
  extractProfileName,
  stripProfilePrefix,
} from '../../lib/session-keys'

export const Route = createFileRoute('/api/agent-kill')({
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
          }
          const rawSessionKey = (body.sessionKey || '').trim()
          if (!rawSessionKey) {
            return json(
              { ok: false, error: 'sessionKey is required' },
              { status: 400 },
            )
          }

          // Resolve profile from qualified sessionKey, then strip the
          // prefix so the gateway call receives the bare session id.
          const profile = extractProfileName(rawSessionKey)
          const sessionKey = stripProfilePrefix(rawSessionKey)
          const activeProfile =
            request.headers.get('X-Hermes-Profile') || undefined
          const resolvedProfile = activeProfile || profile

          await ensureGatewayProbed()
          await deleteSession(sessionKey, resolvedProfile)

          return json({ ok: true, sessionKey, killed: true })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to kill agent',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})