import { describe, expect, it } from 'bun:test'
import * as mailPg from '../src/pg'

describe('the table helper names of 1.91', () => {
  it('lists names as mailTables and no longer exports the old names', () => {
    expect('mailListTables' in mailPg).toBe(false)
    expect('createMailSuppressionTable' in mailPg).toBe(false)
    expect(mailPg.mailTables).toContain('kay_mail_suppressions')
  })
})
