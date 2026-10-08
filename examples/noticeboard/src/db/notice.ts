import type { InferEntity } from '@kaynooo/pg-orm'
import { AuthUsers } from '@kaynooo/kayjs-auth/pg'
import { defineTable } from '@kaynooo/pg-orm'

// A notice pinned to the board, deleted with its author. pg-orm types a column as not null by default but writes NOT NULL only when told.
export const Notice = defineTable('notice', f => ({
  id: f.serial().primaryKey(),
  author_id: f.text().notNull().references(() => AuthUsers, 'id', { onDelete: 'cascade' }),
  title: f.varchar(120).notNull(),
  body: f.text().notNull(),
  posted_at: f.timestamptz().notNull().defaultRaw('now()'),
})).withIndexes([{ columns: ['posted_at'] }])

export type NoticeInterface = InferEntity<typeof Notice>
