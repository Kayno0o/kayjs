import type { ListStore } from './list-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { appDatabase } from 'kay/library'
import { pgLists } from './list-pg'
import { LIST_FILE } from './list-store'
import { log } from './log'

const pgByUrl = new Map<string, ListStore>()
let warned = false

// Where the lists and suppressions of a mailer with no store of its own live: the database of the app's `store` (a Postgres, or the SQLite file of `sqliteData`), else `data/mail-list.sqlite`.
// A `data/mail-list.sqlite` that exists keeps being read, so an app upgrading loses no subscriber; production warns once when it writes to that file instead of the app's database.
export function listsHome(root: string = process.cwd()): { file?: string, store?: ListStore } {
  const database = appDatabase()
  const old = existsSync(`${root}/${LIST_FILE}`)

  if (database !== undefined && !old) {
    if (database.kind === 'sqlite')
      return { file: database.path }

    let store = pgByUrl.get(database.url)

    if (store === undefined)
      pgByUrl.set(database.url, store = pgLists(database.url))

    return { store }
  }

  if (!warned && process.env.NODE_ENV === 'production') {
    warned = true
    log.warn(database === undefined
      ? `the mailing lists are kept in ${LIST_FILE}, a SQLite file: set the app's \`store\` (\`sqliteData\` or \`pgData\`) in kay.config.ts, or give the mailer a \`listStore\`, for a database that outlives a deploy`
      : `the mailing lists are kept in ${LIST_FILE}, which exists, though the app's store names a database: to use that database, move the subscribers into it (or delete the file when it holds none)`)
  }

  return { file: LIST_FILE }
}
