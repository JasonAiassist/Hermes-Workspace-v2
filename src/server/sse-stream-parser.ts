/**
 * SSE stream consumer.
 *
 * Pulls an SSE-encoded ReadableStream byte-by-byte, splits on newlines,
 * and fires a callback for each complete `event: ...\ndata: ...\n`
 * pair. Handles split events across chunk boundaries (partial chunks
 * buffer the trailing incomplete line until the next read).
 *
 * The parser is intentionally callback-based (not Promise-based) so
 * callers can fire-and-forget without awaiting stream completion —
 * the orchestrator dispatches work then lets the stream run in the
 * background while it returns to the caller.
 */

export type SseStreamHandlers = {
  onEvent: (event: string, data: string) => void
  onError: (err: unknown) => void
  onEnd: () => void
}

/**
 * Read an SSE stream until completion, dispatching each event via
 * the supplied handlers. Never throws; errors are reported through
 * `onError` so the caller can keep its own try/catch surface clean.
 */
export function consumeSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: SseStreamHandlers,
): void {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentDataLines: string[] = []

  const flushEvent = () => {
    if (currentEvent && currentDataLines.length > 0) {
      handlers.onEvent(currentEvent, currentDataLines.join('\n'))
    }
    currentEvent = ''
    currentDataLines = []
  }

  const processLine = (line: string) => {
    if (line.startsWith('event:')) {
      flushEvent()
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      currentDataLines.push(line.slice(5).trim())
    } else if (line === '') {
      flushEvent()
    }
  }

  const processBuffer = () => {
    const lines = buffer.split('\n')
    // Keep the last (potentially incomplete) line in the buffer.
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      processLine(line)
    }
  }

  /**
   * Like processBuffer but treats every line as complete — used at EOF
   * where there is no "next read" that could append to a partial line.
   */
  const processBufferAll = () => {
    const lines = buffer.split('\n')
    buffer = ''

    for (const line of lines) {
      processLine(line)
    }
  }

  const readNext = (): Promise<void> =>
    reader
      .read()
      .then(({ done, value }) => {
        if (done) {
          // Flush any decoder state plus any remaining buffer. On EOF
          // there is no "next read", so the trailing line is complete
          // — process it without holding it back for a partial chunk.
          buffer += decoder.decode(undefined, { stream: false })
          processBufferAll()
          flushEvent()
          handlers.onEnd()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        processBuffer()
        return readNext()
      })
      .catch((err) => {
        handlers.onError(err)
      })

  readNext()
}