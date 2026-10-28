import type { Database } from 'bun:sqlite'
import type { Suppression, SuppressionReason } from './events'
import { existsSync } from 'node:fs'
import { openSqlite } from 'kay/library'
import { normalizeAddress } from './list-address'
import { log } from './log'

type Maybe<T> = T | Promise<T>

// Where bounces and complaints are kept, the addresses in `normalizeAddress` form: `pgSuppressions(db)`, `sqliteSuppressions(path)`, or a list store, which keeps them beside its lists.
export interface SuppressionStore {
  // Remembers the address as one not to mail again, keeping the first reason and time it was given.
  suppress: (email: string, reason: SuppressionReason, source: string, now?: number) => Maybe<void>
  // The addresses among these that are suppressed, with why.
  suppressed: (emails: string[]) => Maybe<Suppression[]>
  // Mails the address again; whether it was suppressed.
  lift: (email: string) => Maybe<boolean>
}

// The suppressions table of an open SQLite database, made unless it exists.
export function suppressionsIn(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS kay_mail_suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)')

  const insert = db.query('INSERT OR IGNORE INTO kay_mail_suppressions (email, reason, source, at) VALUES (?1, ?2, ?3, ?4)')
  const remove = db.query('DELETE FROM kay_mail_suppressions WHERE email = ?1')
  const one = db.query<Suppression, [string]>('SELECT email, reason, source, at FROM kay_mail_suppressions WHERE email = ?1')

  return {
    suppress(email: string, reason: SuppressionReason, source: string, now = Date.now()): void {
      insert.run(email, reason, source, now)
    },
    suppressed: (emails: string[]): Suppression[] => emails.flatMap(email => one.get(email) ?? []),
    lift: (email: string): boolean => remove.run(email).changes > 0,
  }
}

// Bounces and complaints in a SQLite file, in the `kay_mail_suppressions` table alone, for a mailer on one server with no list: the file is made by the first suppression, a read or a lift before it finding nobody.
export function sqliteSuppressions(path: string): SuppressionStore {
  let opened: ReturnType<typeof suppressionsIn> | undefined

  const open = (): ReturnType<typeof suppressionsIn> => opened ??= suppressionsIn(openSqlite(path))
  const existing = (): ReturnType<typeof suppressionsIn> | undefined => opened ?? (existsSync(path) ? open() : undefined)

  return {
    suppress: (email, reason, source, now) => open().suppress(email, reason, source, now),
    suppressed: emails => existing()?.suppressed(emails) ?? [],
    lift: email => existing()?.lift(email) ?? false,
  }
}

// The suppressions of a mailer: written to the stores `write` gives, read and lifted in those `read` gives too, so what a store kept before stays in force.
export function suppressionsOf(stores: { write: () => SuppressionStore[], read: () => MaybeSuppressions[] }) {
  const every = (): MaybeSuppressions[] => [...new Set([...stores.write(), ...stores.read()])]

  return {
    // The suppressed among the addresses, by their normalised form; a store that cannot answer must not stop the mail it was asked about.
    suppressed: async (addresses: string[]): Promise<Map<string, Suppression>> => {
      const emails = [...new Set(addresses.flatMap(address => normalizeAddress(address) ?? []))]
      const found = new Map<string, Suppression>()

      if (emails.length === 0)
        return found

      for (const store of every()) {
        try {
          for (const entry of await store.suppressed?.(emails) ?? [])
            found.set(entry.email, entry)
        }
        catch (error) {
          log.warn(`the suppressions of a store could not be read, so its mails go out: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      return found
    },
    suppress: async (email: string, reason: SuppressionReason, source: string): Promise<void> => {
      for (const store of stores.write())
        await store.suppress(email, reason, source)
    },
    lift: async (email: string): Promise<boolean> => {
      let lifted = false

      for (const store of every())
        lifted = await store.lift?.(email) === true || lifted

      return lifted
    },
  }
}

// A store that may keep suppressions, as a list store does when it has the three members.
export type MaybeSuppressions = { [K in keyof SuppressionStore]?: SuppressionStore[K] | undefined }

export function keepsSuppressions<T extends MaybeSuppressions>(store: T): store is T & SuppressionStore {
  return store.suppress !== undefined && store.suppressed !== undefined && store.lift !== undefined
}
