import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentMessage } from '@/lib/agent-message-types'

async function sendMessage(payload: { from: string; to: string; content: string }): Promise<AgentMessage> {
  const res = await fetch('/api/agents/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Failed to send message: ${res.status}`)
  }
  return res.json()
}

async function fetchMessages(profile: string): Promise<AgentMessage[]> {
  const res = await fetch(`/api/agents/messages?profile=${encodeURIComponent(profile)}`)
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`)
  return res.json()
}

async function fetchConversation(a: string, b: string): Promise<AgentMessage[]> {
  const res = await fetch(`/api/agents/conversation?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
  if (!res.ok) throw new Error(`Failed to fetch conversation: ${res.status}`)
  return res.json()
}

export function useAgentMessages(profile: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-messages', profile],
    queryFn: () => fetchMessages(profile),
    enabled: enabled && !!profile,
    refetchInterval: 3000,
  })
}

export function useAgentConversation(a: string, b: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-conversation', a, b],
    queryFn: () => fetchConversation(a, b),
    enabled: enabled && !!a && !!b,
    refetchInterval: 3000,
  })
}

export function useSendAgentMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: sendMessage,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-messages', variables.from] })
      queryClient.invalidateQueries({ queryKey: ['agent-messages', variables.to] })
      queryClient.invalidateQueries({ queryKey: ['agent-conversation', variables.from, variables.to] })
      queryClient.invalidateQueries({ queryKey: ['agent-conversation', variables.to, variables.from] })
    },
  })
}