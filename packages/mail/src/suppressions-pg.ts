import type { SQL } from 'bun'
import type { PgJobsSource } from 'kay/library'
import type { Suppression, SuppressionReason } from './events'
import type { SuppressionStore } from './suppressions'
import { connectionOf, privilegeRefused, relationsMissing } from 'kay/library'

export const SUPPRESSIONS_TABLE = 'CREATE TABLE IF NOT EXISTS kay_mail_suppressions (email text PRIMARY KEY, reason text NOT NULL, source text NOT NULL, at bigint NOT NULL)'

// Bounces and complaints in the app's Postgres, in the `kay_mail_suppressions` table alone, shared by every server: `mailer({ suppressionStore: pgSuppressions(db) })` for a site with no list, `db` a Bun `SQL`, a pg-orm `Database` or a connection URL as `pgData` takes. `pgLists` keeps them the same way beside its lists.
// The table is made by the first suppression, a read or a lift before it finding nobody; a role that may not create it has the owner run `createMailListTables(db)`.
export function pgSuppressions(source: PgJobsSource): SuppressionStore & { close: () => Promise<void> } {
  const db = connectionOf(source)
  let ready: Promise<void> | undefined

  const create = async (): Promise<void> => {
    if (!await relationsMissing(db, ['kay_mail_suppressions']))
      return

    try {
      await db.unsafe(SUPPRESSIONS_TABLE)
    }
    catch (error) {
      if (privilegeRefused(error))
        throw new Error('kayjs-mail: the kay_mail_suppressions table is missing, and the role may not create it: run `await createMailListTables(db)` from kayjs-mail as the database\'s owner, and list `mailListTables` in pg-orm\'s `ignoreTables`', { cause: error })

      throw error
    }
  }

  // A failed creation is tried again by the next suppression rather than kept.
  const created = async (): Promise<SQL> => {
    ready ??= create()

    try {
      await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }

    return db
  }

  // A read makes no table: a database from before suppressions has none, and nobody is suppressed in it.
  const read = async <Row>(text: string, params: unknown[]): Promise<Row[]> => {
    try {
      return await db.unsafe<Row[]>(text, params)
    }
    catch (error) {
      // 42P01: the table does not exist.
      if ((error as { errno?: unknown }).errno === '42P01')
        return []

      throw error
    }
  }

  return {
    async suppress(email: string, reason: SuppressionReason, source: string, now = Date.now()): Promise<void> {
      await (await created()).unsafe('INSERT INTO kay_mail_suppressions (email, reason, source, at) VALUES ($1, $2, $3, $4::bigint) ON CONFLICT DO NOTHING', [email, reason, source, now])
    },
    async suppressed(emails: string[]): Promise<Suppression[]> {
      const found = await read<{ email: string, reason: SuppressionReason, source: string, at: string }>('SELECT email, reason, source, at FROM kay_mail_suppressions WHERE email = ANY($1::text[])', [emails])

      return found.map(row => ({ ...row, at: Number(row.at) }))
    },
    async lift(email: string): Promise<boolean> {
      return (await read('DELETE FROM kay_mail_suppressions WHERE email = $1 RETURNING email', [email])).length > 0
    },
    close: async () => {
      if (typeof source === 'string')
        await db.close()
    },
  }
}
