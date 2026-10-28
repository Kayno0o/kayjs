import type { ListStore } from './list-store'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { openLists } from './list-store'

// Whether the file holds lists, read without making their tables, so a file only suppressions were kept in stays without them.
function holdsLists(path: string): boolean {
  if (!existsSync(path))
    return false

  // Loaded here, as `openSqlite` does, so a server that opens no file never loads it.
  const sqlite = process.getBuiltinModule('bun:sqlite') as typeof import('bun:sqlite')
  const db = new sqlite.Database(path, { readwrite: true, create: false })

  try {
    // As `openSqlite` waits, so another process checkpointing the file does not fail the read.
    db.run('PRAGMA busy_timeout = 5000')

    return db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'kay_mail_subscribers\'').get() !== null
  }
  finally {
    db.close()
  }
}

// The list stores of one mailer: the SQLite files its lists opened, the stores given to them or to the mailer (`fallback.store`), and the default file (`fallback.file`), none when undefined.
export function listRegistry(fallback: { file: string | undefined, store: ListStore | undefined }) {
  const files = new Map<string, ListStore>()
  const given = new Set<ListStore>(fallback.store === undefined ? [] : [fallback.store])
  const defaultPath = fallback.file

  const open = (file: string): ListStore => {
    let lists = files.get(file)

    if (!lists)
      files.set(file, lists = openLists(file))

    return lists
  }

  // The default file once it holds lists, whichever list this process declared.
  const defaultLists = (): ListStore | undefined => defaultPath === undefined ? undefined : files.get(defaultPath) ?? (holdsLists(defaultPath) ? open(defaultPath) : undefined)

  // Every store open in this process or given to it.
  const known = (): ListStore[] => [...new Set([...files.values(), ...given])].filter(store => !store.closed)

  return {
    open,
    give: (store: ListStore): void => void given.add(store),
    // The file's store when it is open or the file exists, so a sweep makes no file.
    existing: (file: string): ListStore | undefined => files.get(file) ?? (existsSync(file) ? open(file) : undefined),
    // Where a link of a list this process has not declared looks: the mailer's store, else the default file, as a link in a mail outlives the code that declared its list.
    fallback: (): ListStore | undefined => fallback.store ?? defaultLists(),
    known,
    // What an erase or a person's export reaches: the known stores and the default file when it holds lists.
    everywhere: (): ListStore[] => {
      defaultLists()

      return known()
    },
  }
}
