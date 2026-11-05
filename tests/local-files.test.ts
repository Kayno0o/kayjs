import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetLocalFiles, warnOfLocalFiles } from '../src/server/local-files'
import { missingStore, notFoundFile } from '../src/server/not-found'
import { sharedStores } from '../src/server/workers'
import { scratchDir } from './scratch'

const SINK = Symbol.for('kay.log')
const global = globalThis as { [SINK]?: unknown }

let told: string[] = []
const kept = { env: process.env.NODE_ENV, workers: process.env.KAY_WORKERS, index: process.env.KAY_WORKER, sink: global[SINK] }

beforeEach(() => {
  told = []
  global[SINK] = (level: string, message: string) => told.push(`${level}: ${message}`)
  resetLocalFiles()
})

afterEach(() => {
  global[SINK] = kept.sink
  for (const [name, value] of [['NODE_ENV', kept.env], ['KAY_WORKERS', kept.workers], ['KAY_WORKER', kept.index]] as const) {
    if (value === undefined)
      delete process.env[name]
    else
      process.env[name] = value
  }
})

describe('workers sharing what the store leaves out', () => {
  it('fills it in the SQLite file the store names, and warns of nothing', async () => {
    const root = await scratchDir('workers-store-')

    process.env.NODE_ENV = 'production'
    process.env.KAY_WORKERS = '2'
    process.env.KAY_WORKER = '0'

    const store = await sharedStores({ database: `sqlite://${root}/app.sqlite` })

    expect(store?.cache).toBeDefined()
    expect(store?.kv).toBeDefined()
    warnOfLocalFiles()
    expect(told).toEqual([])
  })

  it('warns once, in production, when it goes to data/workers.sqlite', async () => {
    process.env.NODE_ENV = 'production'
    process.env.KAY_WORKERS = '2'
    process.env.KAY_WORKER = '0'

    await sharedStores({})
    warnOfLocalFiles()
    warnOfLocalFiles()

    expect(told).toHaveLength(1)
    expect(told[0]).toContain('data/workers.sqlite')
  })

  it('leaves the warning to the first worker, and to production', async () => {
    process.env.KAY_WORKERS = '2'
    process.env.KAY_WORKER = '1'
    process.env.NODE_ENV = 'production'
    await sharedStores({})
    warnOfLocalFiles()

    process.env.KAY_WORKER = '0'
    process.env.NODE_ENV = 'development'
    warnOfLocalFiles()

    expect(told).toEqual([])
  })
})

describe('the 404 log in the store\'s file', () => {
  it('reads and writes the tables of the SQLite file the store names', async () => {
    const root = await scratchDir('not-found-store-')
    const file = notFoundFile(`sqlite://${root}/app.sqlite`, root)
    const store = missingStore(file, false)

    store.hit('/gone', undefined, () => undefined)
    store.hit('/gone', undefined, () => undefined)

    expect(store.list().map(row => row.path)).toEqual(['/gone'])
    store.close()
    expect(await Bun.file(`${root}/app.sqlite`).exists()).toBe(true)
    expect(await Bun.file(`${root}/data/not-found.sqlite`).exists()).toBe(false)
  })
})
