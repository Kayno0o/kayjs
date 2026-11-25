// Single zero-config `bun:sqlite` database powering BOTH @kayjs/auth and notices.

import { Database } from 'bun:sqlite'
import { sqliteAuthStore } from '@kayjs/auth/sqlite'

export interface PinnedNotice {
  id: number
  authorId: string
  author: string
  title: string
  body: string
  postedAt: string
}

interface NoticeRow {
  id: number
  author_id: string
  author_name: string
  title: string
  body: string
  posted_at: string
}

export const db = new Database(process.env.NOTICEBOARD_DB || ':memory:', { create: true })
export const authStore = sqliteAuthStore(db)

db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    posted_at TEXT NOT NULL
  );
`)

function mapRow(row: NoticeRow): PinnedNotice {
  return {
    id: row.id,
    authorId: row.author_id,
    author: row.author_name,
    title: row.title,
    body: row.body,
    postedAt: row.posted_at,
  }
}

export function latestNotices(limit = 50): PinnedNotice[] {
  const rows = db.query<NoticeRow, [number]>(
    'SELECT id, author_id, author_name, title, body, posted_at FROM notices ORDER BY id DESC LIMIT ?',
  ).all(limit)
  return rows.map(mapRow)
}

export function findNotice(id: number): PinnedNotice | undefined {
  if (!Number.isInteger(id) || id <= 0)
    return undefined
  const row = db.query<NoticeRow, [number]>(
    'SELECT id, author_id, author_name, title, body, posted_at FROM notices WHERE id = ?',
  ).get(id)
  return row ? mapRow(row) : undefined
}

export function insertNotice(input: { authorId: string, author: string, title: string, body: string }): PinnedNotice {
  const postedAt = new Date().toISOString()
  const res = db.query<null, [string, string, string, string, string]>(
    'INSERT INTO notices (author_id, author_name, title, body, posted_at) VALUES (?, ?, ?, ?, ?)',
  ).run(input.authorId, input.author, input.title, input.body, postedAt)
  return {
    id: Number(res.lastInsertRowid),
    authorId: input.authorId,
    author: input.author,
    title: input.title,
    body: input.body,
    postedAt,
  }
}

export function listMemberEmails(excludeUserId?: string): string[] {
  const rows = excludeUserId
    ? db.query<{ email: string }, [string]>('SELECT email FROM kay_auth_users WHERE id != ?').all(excludeUserId)
    : db.query<{ email: string }, []>('SELECT email FROM kay_auth_users').all()
  return rows.map(r => r.email)
}
