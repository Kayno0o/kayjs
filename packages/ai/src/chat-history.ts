import type { Message } from './types'

// What a send posts: the latest `keep` messages that have text, from the first user message on, since a provider refuses a history opening on the assistant. The last message is the visitor's, so one is always posted.
export function posted(turns: readonly Message[], keep: number): Message[] {
  const said = turns.filter(({ content }) => content !== '').map(({ role, content }) => ({ role, content }))
  const latest = said.slice(-Math.max(1, keep))
  const first = latest.findIndex(({ role }) => role === 'user')

  return first === -1 ? [] : latest.slice(first)
}
