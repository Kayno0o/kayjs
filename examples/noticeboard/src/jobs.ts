import { AuthUsers } from '@kaynooo/kayjs-auth/pg'
import { queue } from 'kay/server'
import { db } from './db'
import { Notice } from './db/notice'
import { env } from './env'
import { mail } from './mail'
import Announcement from './mails/announcement.kay'

// Tells every other member with a verified address about a new notice, in the background: the post answers at once, and a database hiccup is retried.
export const announcements = queue('announcements', async ({ noticeId }: { noticeId: number }) => {
  const notice = await db.repo(Notice).read.findById(noticeId)

  // Deleted before its turn came.
  if (!notice)
    return

  const users = await db.repo(AuthUsers).read.findMany(q => q.where({ email_verified_at: { isNull: false } }))
  const author = users.find(user => user.id === notice.author_id)?.username ?? 'A member'

  for (const user of users.filter(each => each.id !== notice.author_id && each.email !== null))
    await mail.enqueue({ to: user.email!, subject: `New notice: ${notice.title}`, view: Announcement, props: { title: notice.title, author, url: `${env.SITE_URL}/notices/${notice.id}` } })
}, { attempts: 3 })
