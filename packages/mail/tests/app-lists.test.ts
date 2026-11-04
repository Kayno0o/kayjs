import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { scratchDir } from '../../../tests/scratch'
import { listsHome } from '../src/app-lists'
import { LIST_FILE } from '../src/list-store'

afterEach(() => setupStore(undefined))

describe('where the lists live by default', () => {
  it('is the SQLite file of the app\'s store, a Postgres store, or data/mail-list.sqlite when the app names none', async () => {
    const root = await scratchDir('mail-home')

    expect(listsHome(root)).toEqual({ file: LIST_FILE })

    setupStore({ database: 'sqlite:///srv/app/data/app.sqlite' })
    expect(listsHome(root)).toEqual({ file: '/srv/app/data/app.sqlite' })

    setupStore({ database: 'postgres://user@localhost/app' })

    const home = listsHome(root)

    expect(home.file).toBeUndefined()
    expect(listsHome(root).store).toBe(home.store)
  })

  it('keeps reading an existing data/mail-list.sqlite', async () => {
    const root = await scratchDir('mail-home-old')

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, LIST_FILE), '')
    setupStore({ database: 'sqlite:///srv/app/data/app.sqlite' })
    expect(listsHome(root)).toEqual({ file: LIST_FILE })
  })
})
