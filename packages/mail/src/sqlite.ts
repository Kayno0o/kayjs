import type { MailStore } from './mail-store'

export { sqliteLists } from './list-store'
/** @deprecated Use `sqliteLists`. Removed in 1.108.0; `deprecated-store-names` rewrites it. */
export { sqliteLists as openLists } from './list-store'
export type { MailStore } from './mail-store'

export { sqliteSuppressions } from './suppressions'

// The lists and the bounces of a mailer in one SQLite file, made by the first list or suppression rather than when the app starts: `mail({ store: sqliteMail('data/mail.sqlite') })`, or a list's `store`. Several lists naming the same file share it.
export function sqliteMail(path: string): MailStore {
  return { file: path }
}
