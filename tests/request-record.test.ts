import { join } from 'node:path'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { RequestRecord, requestRecord } from '../src/server/request-record'

const SERVER = join(import.meta.dir, '../src/server')
const PER_REQUEST = /new WeakMap<Request\b/
// Each keeps a map of its own hook's requests, which another app's hook on the same request must not share.
const OWN_HOOK = new Set(['dev.ts', 'log.ts', 'metrics.ts', 'request-record.ts'])

describe('the request record', () => {
  it('holds what kay notes of a request, the server keeping no map of requests of its own beside it', async () => {
    const holding: string[] = []

    for await (const file of new Glob('**/*.ts').scan(SERVER)) {
      if (PER_REQUEST.test(await Bun.file(join(SERVER, file)).text()) && !OWN_HOOK.has(file))
        holding.push(file)
    }

    expect(holding).toEqual([])
  })

  it('is made once per request, every field starting undefined', () => {
    const request = new Request('https://x.example/')
    const record = requestRecord(request)

    expect(requestRecord(request)).toBe(record)
    expect(requestRecord(new Request('https://x.example/'))).not.toBe(record)
    expect(Object.values(record).every(value => value === undefined)).toBe(true)
    expect(Object.keys(record)).toEqual(Object.keys(new RequestRecord()))
  })
})
