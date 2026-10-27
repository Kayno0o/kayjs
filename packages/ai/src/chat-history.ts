import type { ChatMessage, Message } from './types'

// The most characters a send posts unless the chat is told otherwise, under the 50,000 `ask` takes by default.
export const POSTED_CHARACTERS = 40_000

// What a file counts toward that cap, as `ask` prices an image.
const FILE_CHARACTERS = 4000

const cost = ({ content, attachments }: Pick<Message, 'attachments' | 'content'>) => content.length + (attachments?.length ?? 0) * FILE_CHARACTERS

// The files a turn was sent with: those the visitor attached in this page, which a restored turn no longer has.
export function filesOf(turn: Pick<Message, 'attachments'>): File[] {
  return (turn.attachments ?? []).filter(attachment => attachment instanceof File)
}

// What a send posts: the latest `keep` messages that have text or files, from the first user message on, since a provider refuses a history opening on the assistant. The last message is the visitor's, so one is always posted.
export function posted(turns: readonly Message[], keep: number, maxChars = POSTED_CHARACTERS): ChatMessage[] {
  const said = turns.flatMap(({ role, content, attachments }) => {
    const sent = filesOf({ attachments })

    return content === '' && sent.length === 0 ? [] : [{ role, content, ...sent.length > 0 && { attachments: sent } }]
  })
  let latest = said.slice(-Math.max(1, keep))
  let size = latest.reduce((sum, turn) => sum + cost(turn), 0)

  // Long answers must not push the history past what `ask` takes (`maxInputChars`): the oldest turns go first, the last message stays.
  while (size > maxChars && latest.length > 1) {
    size -= cost(latest[0]!)
    latest = latest.slice(1)
  }

  const first = latest.findIndex(({ role }) => role === 'user')

  return first === -1 ? [] : latest.slice(first)
}

// The cap to post under after a 413 for `sent`: half what it held, so a few refusals reach any cap.
export function shrunk(sent: readonly Pick<Message, 'attachments' | 'content'>[]): number {
  return Math.floor(sent.reduce((sum, turn) => sum + cost(turn), 0) / 2)
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

// The reply a tab's last send started, kept beside its turns until the reply ends, so a reload mid-reply asks the server for it again.
export function pendingReply(key: string): string | undefined {
  try {
    return sessionStorage.getItem(`${key}:reply`) ?? undefined
  }
  catch {
    return undefined
  }
}

export function keepPending(key: string, id: string | undefined): void {
  try {
    if (id === undefined)
      sessionStorage.removeItem(`${key}:reply`)
    else
      sessionStorage.setItem(`${key}:reply`, id)
  }
  catch {}
}

// A random name for a reply: `crypto.randomUUID` needs a secure page, which a chat on a home network over http is not.
export function newReplyId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
