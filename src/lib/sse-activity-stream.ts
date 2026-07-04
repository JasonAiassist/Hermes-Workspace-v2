let eventSource: EventSource | null = null
let refCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(event: MessageEvent) => void>()

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
let reconnectDelay = RECONNECT_BASE_MS

function connect() {
  if (eventSource || reconnectTimer) return

  try {
    eventSource = new EventSource('/api/chat-events')
    reconnectDelay = RECONNECT_BASE_MS

    eventSource.addEventListener('activity', (event) => {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          // ignore listener errors
        }
      }
    })

    eventSource.addEventListener('error', () => {
      // Connection lost — schedule reconnect with backoff
      eventSource?.close()
      eventSource = null
      scheduleReconnect()
    })
  } catch {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer || refCount === 0) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

export function subscribeActivity(
  callback: (event: MessageEvent) => void,
): () => void {
  listeners.add(callback)
  refCount++
  connect()

  return () => {
    listeners.delete(callback)
    refCount--
    if (refCount <= 0) {
      disconnect()
    }
  }
}

// Test-only: resets all module-level state so tests run in isolation.
export function __reset(): void {
  listeners.clear()
  refCount = 0
  disconnect()
  reconnectDelay = RECONNECT_BASE_MS
}