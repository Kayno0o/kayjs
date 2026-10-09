import type { NoticeInterface } from './db/notice'
import { AuthUsers } from '@kaynooo/kayjs-auth/pg'
import { db } from './db'
import { Notice } from './db/notice'

export interface PinnedNotice extends NoticeInterface {
  author: string
}

// The latest notices with their authors' names, newest first.
export async function latestNotices(limit = 50): Promise<PinnedNotice[]> {
  return withAuthors(await db.repo(Notice).read.findMany(q => q.orderBy('posted_at', 'desc').orderBy('id', 'desc').limit(limit)))
}

export async function findNotice(id: number): Promise<PinnedNotice | undefined> {
  const notice = await db.repo(Notice).read.findById(id)

  return notice ? (await withAuthors([notice]))[0] : undefined
}

async function withAuthors(notices: NoticeInterface[]): Promise<PinnedNotice[]> {
  const ids = [...new Set(notices.map(notice => notice.author_id))]
  const authors = await db.repo(AuthUsers).read.findMany({ id: ids })
  const names = new Map(authors.map(author => [author.id, author.username ?? 'A member']))

  return notices.map(notice => ({ ...notice, author: names.get(notice.author_id) ?? 'A member' }))
}
