import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { scratchDir } from '../../../tests/scratch'
import { listsHome, warnLocalLists } from '../src/app-lists'
import { createLists } from '../src/list'
import { LIST_FILE } from '../src/list-store'
import { logged } from './fixture/tests/logged'

afterEach(() => setupStore(undefined))

const host = { configured: () => true, render: async () => {
  throw new Error('unused')
}, deliver: async () => undefined }

describe('where the lists live by default', () => {
  it('is the SQLite file of the app\'s store, its Postgres connection, or data/mail-list.sqlite when the app names none', async () => {
    const root = await scratchDir('mail-home')

    expect(listsHome(root)).toMatchObject({ file: LIST_FILE, local: true })

    setupStore({ database: 'sqlite:///srv/app/data/app.sqlite' })
    expect(listsHome(root)).toMatchObject({ file: '/srv/app/data/app.sqlite', local: false })

    setupStore({ database: 'postgres://user@localhost/app' })

    const home = listsHome(root)

    expect(home.file).toBeUndefined()
    expect(home.local).toBe(false)
    expect(listsHome(root).store).toBe(home.store)
  })

  it('follows a pgData given a connection, which names no url, and shares its connection', async () => {
    const root = await scratchDir('mail-home-sql')
    const sql = new Bun.SQL('postgres://user@127.0.0.1:1/app')

    setupStore({ sql })

    const home = listsHome(root)

    expect(home.local).toBe(false)
    expect(home.store).toBeDefined()
    await sql.close()
  })

  it('keeps reading an existing data/mail-list.sqlite', async () => {
    const root = await scratchDir('mail-home-old')

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, LIST_FILE), '')
    setupStore({ database: 'sqlite:///srv/app/data/app.sqlite' })
    expect(listsHome(root)).toMatchObject({ file: LIST_FILE, local: true })
  })
})

describe('a mailer\'s lists on the app\'s store', () => {
  it('writes its suppressions in the SQLite file of sqliteData, and warns in production about a local file once, on a write', async () => {
    const root = await scratchDir('mail-through')
    const file = join(root, 'app.sqlite')
    const address = `bounced.${Date.now()}@example.com`
    const mode = process.env.NODE_ENV

    setupStore({ database: `sqlite://${file}` })
    process.env.NODE_ENV = 'development'

    try {
      const lines = await logged(async () => {
        const lists = createLists(host)

        await lists.suppress(address, 'bounce', 'test')
        expect([...(await lists.suppressed([address])).keys()]).toEqual([address])
      })

      expect(lines).toEqual([])
      expect(new Database(file).query('SELECT email FROM kay_mail_suppressions').all()).toEqual([{ email: address }])

      setupStore(undefined)
      process.env.NODE_ENV = 'production'

      const warned = await logged(async () => {
        warnLocalLists(listsHome(root))
        warnLocalLists(listsHome(root))
      })

      expect(warned).toHaveLength(1)
      expect(warned[0]![1]).toContain('data/mail-list.sqlite')
    }
    finally {
      if (mode === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = mode
    }
  })

  it('warns of nothing for a mailer on the app\'s store, nor on a read of the suppressions', async () => {
    const root = await scratchDir('mail-quiet')
    const mode = process.env.NODE_ENV

    setupStore({ database: `sqlite://${join(root, 'app.sqlite')}` })
    process.env.NODE_ENV = 'production'

    try {
      const lines = await logged(async () => {
        warnLocalLists(listsHome(root))
        await createLists(host).suppressed(['someone@example.com'])
      })

      expect(lines).toEqual([])
    }
    finally {
      if (mode === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = mode
    }
  })
})
