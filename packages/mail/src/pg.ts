export { createMailTables, mailTables, pgLists, pgMail } from './list-pg'
/** @deprecated `createMailTables`, since 1.105. */
export { createMailTables as createMailListTables } from './list-pg'
/** @deprecated `mailTables`, since 1.105. */
export { mailTables as mailListTableNames } from './list-pg'

export type { MailStore } from './mail-store'

export { createMailSuppressionTables, pgSuppressions } from './suppressions-pg'
