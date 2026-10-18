import type { Message } from './types'

// What a send posts: the latest `keep` messages that have text, from the first user message on, since a provider refuses a history opening on the assistant. The last message is the visitor's, so one is always posted.
export function posted(turns: readonly Message[], keep: number): Message[] {
  const said = turns.filter(({ content }) => content !== '').map(({ role, content }) => ({ role, content }))
  const latest = said.slice(-Math.max(1, keep))
  const first = latest.findIndex(({ role }) => role === 'user')

  return first === -1 ? [] : latest.slice(first)
}

// What a stopped or finished conversation keeps in session storage: the text of each turn, not the tool calls, whose arguments and results may be large.
const KEPT_CHARACTERS = 200_000

interface KeptTurn extends Message {
  stopped?: boolean | undefined
}

// The turns a tab kept under `key`, or none when storage is unavailable or holds something else.
export function restored(key: string): KeptTurn[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')

    if (!Array.isArray(value))
      return []

    return value.flatMap((turn: unknown) => {
      if (typeof turn !== 'object' || turn === null)
        return []

      const { role, content, stopped } = turn as Record<string, unknown>

      return (role === 'user' || role === 'assistant') && typeof content === 'string' && content !== '' ? [{ role, content, ...stopped === true && { stopped } }] : []
    })
  }
  catch {
    return []
  }
}

// Keeps the latest turns with text that fit; storage that is full or unavailable keeps nothing, and the chat goes on.
export function stored(key: string, turns: readonly KeptTurn[]): void {
  try {
    let kept = turns.filter(({ content }) => content !== '').map(({ role, content, stopped }) => ({ role, content, ...stopped === true && { stopped } }))
    let text = JSON.stringify(kept)

    while (text.length > KEPT_CHARACTERS && kept.length > 0) {
      kept = kept.slice(1)
      text = JSON.stringify(kept)
    }

    sessionStorage.setItem(key, text)
  }
  catch {
    // The value kept before would come back as an older conversation.
    try {
      sessionStorage.removeItem(key)
    }
    catch {}
  }
}
