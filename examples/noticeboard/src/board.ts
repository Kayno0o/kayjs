import { s } from 'kay'
import { rooms } from 'kay/server'

export const BOARD = 'board'

// What every open board page hears: a notice as it is posted, and who is reading.
export const boardMessage = s.union([
  s.object({ type: s.literal('posted'), notice: s.object({ id: s.number(), title: s.string(), author: s.string() }) }),
  s.object({ type: s.literal('present'), names: s.list(s.string()), guests: s.number() }),
])

export type BoardMessage = typeof boardMessage.static

// Each connection is listed as its member's name, or null for a visitor who has not signed in.
export const board = rooms<BoardMessage, string | null>()

// Who reads the board, sent once however many open or close together.
export const sendPresence = board.coalesce((room): BoardMessage => {
  const members = board.members(room)

  return { type: 'present', names: [...new Set(members.filter(name => name !== null))].sort(), guests: members.filter(name => name === null).length }
})
