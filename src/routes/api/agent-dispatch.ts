/**
 * Agent dispatch endpoint for the Mission Orchestrator.
 *
 * Receives a batched task assignment from the Conductor / Agent Hub,
 * forwards it to the target agent session via the gateway's stream
 * endpoint, and returns immediately. The orchestrator's SSE stream
 * listeners pick up progress in real time.
 *
 * SSE parsing is delegated to consumeSseStream from
 * ../server/sse-stream-parser so this route stays focused on the
 * dispatch flow.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { publishMissionEvent } from '../../server/chat-event-bus'
import { consumeSseStream } from '../../server/sse-stream-parser'
import {
  extractProfileName,
  stripProfilePrefix,
} from '../../lib/session-keys'

export const Route = createFileRoute('/api/agent-dispatch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as Record<string, unknown>

          const rawSessionKey =
            typeof body.sessionKey === 'string'
              ? body.sessionKey.trim()
              : ''
          const message =
            typeof body.message === 'string' ? body.message.trim() : ''
          const model =
            typeof body.model === 'string' ? body.model.trim() : undefined
          const missionName =
            typeof body.missionName === 'string'
              ? body.missionName.trim()
              : undefined
          const agentId =
            typeof body.agentId === 'string' ? body.agentId.trim() : undefined

          if (!rawSessionKey) {
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

          // Resolve profile from qualified session key or header so
          // downstream /api/send routes to the correct gateway.
          const profileFromKey = extractProfileName(rawSessionKey)
          const activeProfile =
            request.headers.get('X-Hermes-Profile')?.trim() ||
            profileFromKey ||
            undefined

          // Strip profile prefix before forwarding — /api/send will
          // re-qualify with the correct profile context.
          const sessionKey = stripProfilePrefix(rawSessionKey)

          // Synchronous dispatch: await downstream response headers so
          // the orchestrator knows immediately if /api/send failed.
          const url = new URL('/api/send?stream=true', request.url)
          const cookie = request.headers.get('cookie') || ''
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          }
          if (activeProfile) {
            headers['X-Hermes-Profile'] = activeProfile
          }

          const payload: Record<string, unknown> = {
            sessionKey,
            message,
            source: 'mission',
          }
          if (model) payload.model = model
          if (missionName) payload.missionName = missionName
          if (agentId) payload.agentId = agentId

          let response: Response
          try {
            response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
              // Long timeout: agent runs can take 3-10 minutes
              signal: AbortSignal.timeout(600_000),
            })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return json(
              { ok: false, error: `Failed to reach /api/send: ${message}` },
              { status: 502 },
            )
          }

          if (!response.ok) {
            const text = await response.text().catch(() => 'unknown')
            return json(
              {
                ok: false,
                error: `Downstream /api/send returned ${response.status}: ${text}`,
              },
              { status: 502 },
            )
          }

          const contentType = response.headers.get('content-type') || ''
          if (!contentType.includes('text/event-stream')) {
            const text = await response.text().catch(() => 'unknown')
            return json(
              {
                ok: false,
                error: `Expected SSE stream, got ${contentType}: ${text}`,
              },
              { status: 502 },
            )
          }

          // Parse the SSE body in the background so the connection
          // doesn't hang. Error events are forwarded to chat-event-bus
          // so the orchestrator sees them via /api/chat-events
          // instead of waiting forever.
          if (response.body) {
            const reader = response.body.getReader()
            let sawError = false
            let sawDone = false

            consumeSseStream(reader, {
              onEvent: (event, data) => {
                if (event === 'error') {
                  sawError = true
                  try {
                    const parsed = JSON.parse(data) as Record<string, unknown>
                    publishMissionEvent('error', {
                      ...parsed,
                      sessionKey: rawSessionKey,
                    })
                  } catch {
                    publishMissionEvent('error', {
                      message: data,
                      sessionKey: rawSessionKey,
                    })
                  }
                } else if (event === 'done') {
                  sawDone = true
                }
              },
              onError: (err) => {
                const errorMsg =
                  err instanceof Error ? err.message : String(err)
                console.error(
                  '[agent-dispatch] SSE stream read error for session:',
                  rawSessionKey,
                  err,
                )
                publishMissionEvent('error', {
                  message: `Stream read error: ${errorMsg}`,
                  sessionKey: rawSessionKey,
                })
              },
              onEnd: () => {
                if (!sawDone && !sawError) {
                  console.warn(
                    '[agent-dispatch] SSE stream ended unexpectedly for session:',
                    rawSessionKey,
                  )
                  publishMissionEvent('error', {
                    message: 'Stream ended unexpectedly without completion',
                    sessionKey: rawSessionKey,
                  })
                }
              },
            })
          }

          return json({ ok: true, sessionKey: rawSessionKey, queued: true })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to dispatch message',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})