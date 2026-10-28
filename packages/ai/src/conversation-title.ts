// What the server and the Chat share of a conversation held on the server: its title and what the calls reading or changing it answer.
import type { ChatTurn } from './types'

const TITLE_CHARS = 60
const SPACES = /\s+/g

export interface ConversationSummary {
  id: string
  // The opening words of its first message until renamed; empty when it opened on files alone.
  title: string
  // When its turns or its title last changed, in ms.
  updatedAt: number
}

// What a load, a list, a rename or a remove answers, as the JSON text of the one snapshot of its reply; `owned` is false for a visitor no one names, who keeps their history in the page.
export type ConversationAnswer
  = | { owned: false }
    | { owned: true, op: 'load', id: string | undefined, revision: number, title: string, turns: (ChatTurn & { stopped?: boolean | undefined })[] }
    | { owned: true, op: 'list', conversations: ConversationSummary[] }
    | { owned: true, op: 'rename', id: string, done: boolean }
    | { owned: true, op: 'remove', id: string, done: boolean }

// The opening words of a conversation's first message, cut between code points at a word where one ends close enough; empty for a message of files alone.
export function titleOf(text: string): string {
  const words = text.replaceAll(SPACES, ' ').trim()
  const points = [...words]

  if (points.length <= TITLE_CHARS)
    return words

  const cut = points.slice(0, TITLE_CHARS).join('')
  const space = cut.lastIndexOf(' ')

  return `${space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut}…`
}

// A title a rename gives, kept to one line of at most 120 characters.
export function renamedTitle(text: string): string {
  return [...text.replaceAll(SPACES, ' ').trim()].slice(0, 120).join('')
}
