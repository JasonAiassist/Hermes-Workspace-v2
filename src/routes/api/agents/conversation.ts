import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getAgentConversation } from '../../../server/agent-messaging'
import { VALID_PROFILE_NAME } from '../../../lib/agent-message-types'

export const Route = createFileRoute('/api/agents/conversation')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await isAuthenticated(request)
        if (!auth) return json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const a = url.searchParams.get('a')
        const b = url.searchParams.get('b')

        if (!a || !b) {
          return json({ error: 'Missing a or b query parameter' }, { status: 400 })
        }
        if (!VALID_PROFILE_NAME.test(a) || !VALID_PROFILE_NAME.test(b)) {
          return json({ error: 'Invalid profile name' }, { status: 400 })
        }

        const messages = getAgentConversation(a, b)
        return json(messages, { status: 200 })
      },
    },
  },
})