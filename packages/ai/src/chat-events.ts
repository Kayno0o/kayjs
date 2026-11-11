// The text an event of the chat carries: `{ text }` as `kai:chat-send` and `kai:chat-draft` send it, or the bare string their old names `kai-chat-send` and `kai-chat-draft` carried (heard until 1.103). Blank text is none.
export function eventText(detail: unknown): string | undefined {
  const text = typeof detail === 'object' && detail !== null && 'text' in detail ? detail.text : detail

  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
