import type { SQL } from 'bun'

import type { ListStore } from './list-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { appDatabase, appStore } from 'kay/library'
import { pgLists } from './list-pg'
import { LIST_FILE } from './list-store'
import { log } from './log'

export interface ListsHome {
  file?: string | undefined
  store?: ListStore | undefined
  // The lists go to a local file the app's `store` does not name.
  local: boolean
}

const pgBySource = new Map<SQL | string, ListStore>()
let warned = false
let last: { store: unknown, root: string, home: ListsHome } | undefined

// Where the lists and suppressions of a mailer with no store of its own live: the database of the app's `store` (the Postgres connection of `pgData`, or the SQLite file of `sqliteData`), else `data/mail-list.sqlite`.
// A `data/mail-list.sqlite` that exists keeps being read, so an app upgrading loses no subscriber. Worked out once per store setup.
export function listsHome(root: string = process.cwd()): ListsHome {
  const store = appStore()

  if (last !== undefined && last.store === store && last.root === root)
    return last.home

  const database = appDatabase()
  const old = existsSync(`${root}/${LIST_FILE}`)
  let home: ListsHome = { file: LIST_FILE, local: true }

  if (database !== undefined && !old) {
    if (database.kind === 'sqlite') {
      home = { file: database.path, local: false }
    }
    else {
      let kept = pgBySource.get(database.source)

      if (kept?.closed === true)
        kept = undefined

      if (kept === undefined)
        pgBySource.set(database.source, kept = pgLists(database.source))

      home = { store: kept, local: false }
    }
  }

  last = { store, root, home }

  return home
}

// Production warns once, when a list or a suppression is written to a local file: reading the suppressions of a send makes no noise.
export function warnLocalLists(home: ListsHome): void {
  if (!home.local || warned || process.env.NODE_ENV !== 'production')
    return

  warned = true

  const database = appDatabase()

  log.warn(database === undefined
    ? `the mailing lists are kept in ${LIST_FILE}, a SQLite file: set the app's \`store\` (\`sqliteData\` or \`pgData\`) in kay.config.ts, or give the mailer a \`listStore\`, for a database that outlives a deploy`
    : `the mailing lists are kept in ${LIST_FILE}, which exists, though the app's store names a database: to use that database, move the subscribers into it (or delete the file when it holds none)`)
}
