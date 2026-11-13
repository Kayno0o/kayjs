// The text an event of the chat carries: `{ text }` as `kai:chat-send` and `kai:chat-draft` send it. Blank text is none.
export function eventText(detail: unknown): string | undefined {
  const text = typeof detail === 'object' && detail !== null && 'text' in detail ? detail.text : undefined

  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}
