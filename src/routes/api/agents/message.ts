import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../server/auth-middleware'
import { sendAgentMessage } from '../../../server/agent-messaging'
import { VALID_PROFILE_NAME } from '../../../lib/agent-message-types'

export const Route = createFileRoute('/api/agents/message')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await isAuthenticated(request)
        if (!auth) return json({ error: 'Unauthorized' }, { status: 401 })

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON' }, { status: 400 })
        }

        const from = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).from : undefined
        const to = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).to : undefined
        const content = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).content : undefined

        if (!from || !to || !content) {
          return json({ error: 'Missing required fields: from, to, content' }, { status: 400 })
        }
        if (typeof from !== 'string' || typeof to !== 'string' || typeof content !== 'string') {
          return json({ error: 'Fields must be strings' }, { status: 400 })
        }
        if (!VALID_PROFILE_NAME.test(from) || !VALID_PROFILE_NAME.test(to)) {
          return json({ error: 'Invalid profile name' }, { status: 400 })
        }

        try {
          const message = await sendAgentMessage({ from, to, content })
          return json(message, { status: 200 })
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to send message'
          return json({ error: msg }, { status: 500 })
        }
      },
    },
  },
})