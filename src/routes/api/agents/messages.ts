import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentMessagesFor } from '../../../server/agent-messaging'
import { VALID_PROFILE_NAME } from '../../../lib/agent-message-types'

export const Route = createFileRoute('/api/agents/messages')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await isAuthenticated(request)
        if (!auth) return json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const profile = url.searchParams.get('profile')

        if (!profile) {
          return json({ error: 'Missing profile query parameter' }, { status: 400 })
        }
        if (!VALID_PROFILE_NAME.test(profile)) {
          return json({ error: 'Invalid profile name' }, { status: 400 })
        }

        const messages = getAgentMessagesFor(profile)
        return json(messages, { status: 200 })
      },
    },
  },
})