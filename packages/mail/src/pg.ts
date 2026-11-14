export { createMailTables, mailTables, pgLists, pgMail } from './list-pg'
/** @deprecated Use `createMailTables`. Removed in 1.108.0; `deprecated-store-names` rewrites it. */
export { createMailTables as createMailListTables } from './list-pg'
/** @deprecated Use `mailTables`. Removed in 1.108.0; `deprecated-store-names` rewrites it. */
export { mailTables as mailListTableNames } from './list-pg'

export type { MailStore } from './mail-store'

export { createMailSuppressionTables, pgSuppressions } from './suppressions-pg'
