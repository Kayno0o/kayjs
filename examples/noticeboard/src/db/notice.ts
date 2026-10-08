import type { InferEntity } from '@kaynooo/pg-orm'
import { AuthUsers } from '@kaynooo/kayjs-auth/pg'
import { defineTable } from '@kaynooo/pg-orm'

// A notice pinned to the board, deleted with its author.
export const Notice = defineTable('notice', f => ({
  id: f.serial().primaryKey(),
  author_id: f.text().references(() => AuthUsers, 'id', { onDelete: 'cascade' }),
  title: f.varchar(120),
  body: f.text(),
  posted_at: f.timestamptz().defaultRaw('now()'),
})).withIndexes([{ columns: ['posted_at'] }])

export type NoticeInterface = InferEntity<typeof Notice>
