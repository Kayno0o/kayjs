import { describe, expect, it } from 'bun:test'
import * as mailPg from '../src/pg'

describe('the table helper names of 1.91', () => {
  it('lists names as mailListTableNames and keeps the old names', () => {
    expect(mailPg.mailListTables).toBe(mailPg.mailListTableNames)
    expect(mailPg.createMailSuppressionTable).toBe(mailPg.createMailSuppressionTables)
    expect(mailPg.mailListTableNames).toContain('kay_mail_suppressions')
  })
})
