export interface Seen {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

export type Event = [event: string | undefined, data: unknown]

const encoder = new TextEncoder()

export function frame([event, data]: Event): string {
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

// A server-sent event response of these events; `hold` leaves the body open after them, and `cancelled` resolves once the client closed it.
export function stream(events: Event[], { hold = false, raw = '' }: { hold?: boolean, raw?: string } = {}): { response: Response, cancelled: Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(events.map(frame).join('') + raw))

      if (!hold)
        controller.close()
    },
    cancel() {
      resolve()
    },
  })

  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), cancelled: promise }
}

// A local stand-in for a provider on a port of its own, keeping what it was asked.
export function provider(handle: (request: Request, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const entry = { url: new URL(request.url).pathname, headers: request.headers, body: await request.json() as Record<string, unknown> }

      seen.push(entry)

      return handle(request, entry)
    },
  })

  return { url: `http://localhost:${server.port}`, seen, stop: async () => server.stop(true) }
}

export function openaiEvents(...texts: string[]): Event[] {
  return [
    ...texts.map((content, index): Event => [undefined, { choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }] }]),
    [undefined, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
    [undefined, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }],
    [undefined, '[DONE]'],
  ]
}

export function anthropicEvents(...texts: string[]): Event[] {
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 25, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ...texts.map((text): Event => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
}
