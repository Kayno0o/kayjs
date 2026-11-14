import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from '../../../tests/scratch'
import { sqliteLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import * as pg from '../src/pg'
import * as sqlite from '../src/sqlite'

describe('the store of a mailer and of a list', () => {
  it('keeps a list in the file sqliteMail names, which file named before 1.105, made by the first use', async () => {
    const file = join(await scratchDir('mail-store-file'), 'lists.sqlite')
    const app = mailer({ from: 'a@fixture.test' })
    const list = app.list('news', { store: sqlite.sqliteMail(file) })

    expect(existsSync(file)).toBe(false)
    expect(await list.count()).toBe(0)
    expect(existsSync(file)).toBe(true)
    expect(() => app.list('news', { file })).not.toThrow()
    expect(() => app.list('news', { file: 'other.sqlite' })).toThrow('a list keeps one')
  })

  it('takes a ListStore as a list\'s store, as it did before 1.105', async () => {
    const store = sqliteLists(':memory:')
    const app = mailer({ from: 'a@fixture.test' })

    app.list('news', { store })
    expect(() => app.list('news', { store: { lists: store } })).not.toThrow()
    expect(() => app.list('news', { store: sqliteLists(':memory:') })).toThrow('another store')
  })

  it('reads a mailer\'s lists from store.lists, store.suppressions and store.file, and from listStore and suppressionStore as before', async () => {
    const lists = sqliteLists(':memory:')

    const ask = async (app: ReturnType<typeof mailer>) => {
      await lists.ask('known', 'a@example.com', 'a', 'en')

      return app.list('known').count()
    }

    expect(await ask(mailer({ from: 'a@fixture.test', store: { lists } }))).toBe(0)
    expect(await ask(mailer({ from: 'a@fixture.test', listStore: lists }))).toBe(0)

    const file = join(await scratchDir('mail-store-mailer'), 'mail.sqlite')
    const app = mailer({ from: 'a@fixture.test', store: sqlite.sqliteMail(file) })

    await app.suppress('b@example.com')
    expect(existsSync(file)).toBe(true)
  })

  it('refuses store beside listStore or suppressionStore', () => {
    expect(() => mailer({ from: 'a@fixture.test', store: {}, listStore: sqliteLists(':memory:') })).toThrow('replaces `listStore` and `suppressionStore`')
    expect(() => mailer({ from: 'a@fixture.test', store: {}, suppressionStore: sqlite.sqliteSuppressions(':memory:') })).toThrow('replaces `listStore` and `suppressionStore`')
  })

  it('keeps the names of before 1.105 as the new ones', () => {
    expect(pg.mailListTableNames).toBe(pg.mailTables)
    expect(pg.createMailListTables).toBe(pg.createMailTables)
    expect(pg.mailTables).toEqual(['kay_mail_subscribers', 'kay_mail_broadcasts', 'kay_mail_deliveries', 'kay_mail_suppressions'])
    expect(sqlite.openLists).toBe(sqlite.sqliteLists)
  })
})

describe('a store holding lists and a file', () => {
  it('is refused by a mailer and by a list, which keep the bounces with the lists or in the file', () => {
    const lists = sqliteLists(':memory:')

    expect(() => mailer({ from: 'a@fixture.test', store: { lists, file: 'x.sqlite' } })).toThrow('`lists` or a `file`')
    expect(() => mailer({ from: 'a@fixture.test' }).list('news', { store: { lists, file: 'x.sqlite' } })).toThrow('`lists` or a `file`')
  })
})
