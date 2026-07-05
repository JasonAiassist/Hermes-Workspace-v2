/**
 * Agent steer endpoint — send a directive message to an active agent
 * session. Receives { sessionKey, message } and forwards to the
 * streaming send pipeline fire-and-forget. The caller discovers the
 * reply via SSE events or polling.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { extractProfileName } from '../../lib/session-keys'

export const Route = createFileRoute('/api/agent-steer')({
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
            message?: string
          }
          const sessionKey = (body.sessionKey || '').trim()
          const message = (body.message || '').trim()
          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey is required' },
              { status: 400 },
            )
          }
          if (!message) {
            return json(
              { ok: false, error: 'message is required' },
              { status: 400 },
            )
          }

          // Fire-and-forget: kick off the stream, then return immediately.
          const url = new URL('/api/send?stream=true', request.url)
          const cookie = request.headers.get('cookie') || ''
          const activeProfile =
            extractProfileName(sessionKey) ??
            request.headers.get('X-Hermes-Profile') ??
            undefined
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          }
          if (activeProfile) {
            headers['X-Hermes-Profile'] = activeProfile
          }

          fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ sessionKey, message }),
          }).catch(() => {
            // swallow; UI discovers failures via SSE or status polling
          })

          return json({ ok: true, sessionKey, queued: true })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to steer agent',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})