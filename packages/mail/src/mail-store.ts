import type { ListStore } from './list-store'
import type { SuppressionStore } from './suppressions'

// Where a mailer keeps what outlives a process, `store` of `mail()`; a list's `store` reads `lists` and `file` alone, the bounces being the mailer's: `pgMail(db)` for a site on Postgres or on several servers, `sqliteMail(path)` for one SQLite file, or a store of your own for each kind, either optional.
export interface MailStore {
  // The mailing lists: their subscribers, confirmations and broadcasts. Bounces and complaints are kept beside them unless `suppressions` says elsewhere.
  lists?: ListStore | undefined
  // Bounces and complaints. Without it they go where the lists keep theirs, else in the app's database or `data/app.sqlite`.
  suppressions?: SuppressionStore | undefined
  // One SQLite file holding both, opened by the first list or suppression rather than at start, which `sqliteMail(path)` gives; not with `lists`.
  file?: string | undefined
}

// A list takes a `ListStore` too, as it did before 1.105.
export function partsOf(store: ListStore | MailStore | undefined): MailStore {
  if (store === undefined)
    return {}

  return 'ask' in store ? { lists: store } : store
}
