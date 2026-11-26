// Shared @kayjs/auth, @kayjs/mail, and @kayjs/live services for Noticeboard.

import type { PinnedNotice } from './db'
import { createAuth } from '@kayjs/auth'
import { createRooms } from '@kayjs/live'
import { createMailer } from '@kayjs/mail'
import { authStore } from './db'

export type BoardMessage =
  | { type: 'posted', notice: PinnedNotice }
  | { type: 'present', names: string[], guests: number }

export const BOARD_ROOM = 'board'

export const mail = createMailer({
  from: 'Noticeboard <board@noticeboard.local>',
  optional: true,
})

export const auth = createAuth({
  store: authStore,
  secret: process.env.AUTH_SECRET || 'noticeboard-dev-secret-change-me',
  // Public origin of the board: sign-in links are mailed from it, and only localhost works without it.
  site: process.env.SITE_URL || undefined,
  // Local demo opts out of email verification so interactive sign-up lands straight on the board.
  requireEmailVerification: false,
  defaultRedirect: '/',
  mailer: mail,
})

export const board = createRooms<BoardMessage, string | null>({
  path: '/api/board',
  room: BOARD_ROOM,
  member: (ctx) => {
    const user = auth.getUser(ctx)
    return user ? (user.name || user.email) : null
  },
  onJoin: room => sendPresence(room),
  onLeave: room => sendPresence(room),
})

export const sendPresence = board.coalesce((room): BoardMessage => {
  const members = board.members(room)
  const names = [...new Set(members.filter((m): m is string => m !== null))].sort()
  const guests = members.filter(m => m === null).length
  return { type: 'present', names, guests }
})
