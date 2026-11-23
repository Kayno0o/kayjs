// Unified Standard-Schema server action: pins a notice to SQLite, emails members via @kayjs/mail,
// and broadcasts live to every connected browser tab via @kayjs/live.

import type { StandardSchemaV1 } from 'kay/server'
import { action } from 'kay/server'
import { insertNotice, listMemberEmails } from '../db'
import { auth, BOARD_ROOM, board, mail } from '../services'

interface PinInput {
  title: string
  body: string
}

const pinSchema: StandardSchemaV1<PinInput, PinInput> = {
  '~standard': {
    version: 1,
    vendor: 'noticeboard',
    validate(raw) {
      const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const title = typeof obj.title === 'string' ? obj.title.trim() : ''
      const body = typeof obj.body === 'string' ? obj.body.trim() : ''
      const issues: Array<{ message: string, path: string[] }> = []
      if (!title)
        issues.push({ message: 'Write a title', path: ['title'] })
      else if (title.length > 120)
        issues.push({ message: 'Title must be 120 characters or fewer', path: ['title'] })
      if (!body)
        issues.push({ message: 'Write the notice', path: ['body'] })
      else if (body.length > 4000)
        issues.push({ message: 'Notice must be 4000 characters or fewer', path: ['body'] })
      if (issues.length > 0)
        return { issues }
      return { value: { title, body } }
    },
  },
}

export const pinNotice = action(pinSchema, async ({ title, body }, ctx) => {
  const user = auth.getUser(ctx)
  if (!user)
    return ctx.deny(401, 'Sign in to pin a notice')

  const author = user.name || user.email
  const notice = insertNotice({ authorId: user.id, author, title, body })

  // Notify other members via @kayjs/mail
  const recipients = listMemberEmails(user.id)
  if (recipients.length > 0) {
    await mail.send({
      to: recipients,
      subject: `[Noticeboard] ${notice.title}`,
      text: `${notice.author} pinned "${notice.title}":\n\n${notice.body}`,
    })
  }

  // Broadcast live to every connected board reader
  board.publish(BOARD_ROOM, { type: 'posted', notice })

  return notice
})
