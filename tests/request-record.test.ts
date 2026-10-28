import { join } from 'node:path'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { RequestRecord, requestRecord } from '../src/server/request-record'

const SERVER = join(import.meta.dir, '../src/server')
const PER_REQUEST_ALL = /new WeakMap<Request\b/g
// The record's own map, and one map each of its own hook's requests, which another app's hook on the same request must not share.
const OWN_MAPS: Record<string, number> = { 'request-record.ts': 1, 'dev.ts': 1, 'log.ts': 1, 'metrics.ts': 1 }

describe('the request record', () => {
  it('holds what kay notes of a request, the server keeping no map of requests of its own beside it', async () => {
    const holding: string[] = []

    for await (const file of new Glob('**/*.ts').scan(SERVER)) {
      const maps = (await Bun.file(join(SERVER, file)).text()).match(PER_REQUEST_ALL)?.length ?? 0

      if (maps > (OWN_MAPS[file] ?? 0))
        holding.push(file)
    }

    expect(holding).toEqual([])
  })

  it('is made once per request, every field starting undefined', () => {
    const request = new Request('https://x.example/')
    const record = requestRecord(request)

    expect(requestRecord(request)).toBe(record)
    expect(requestRecord(new Request('https://x.example/'))).not.toBe(record)
    expect(record).toBeInstanceOf(RequestRecord)
    expect(Object.values(record).every(value => value === undefined)).toBe(true)
  })
})
