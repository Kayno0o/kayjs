import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { kayCheck } from './check-helper'
import { fixtureCopy } from './scratch'

const site = await testSite({ routes: 'tests/fixtures/shared-schema/src/routes' })

afterAll(async () => site.close())

describe('a schema shared by a server module and an island', () => {
  it('builds an island reading only the schema\'s type, shipping none of the schema', async () => {
    const response = await site.fetch('/')
    const html = await response.text()
    const chunks = [...html.matchAll(/(?:href|src)="(\/_kay\/[^"]+\.js)"/g)].map(match => match[1]!)

    expect(response.status).toBe(200)
    expect(html).toContain('class="flip"')

    for (const chunk of chunks) {
      const code = await (await site.fetch(chunk)).text()

      expect(code).not.toContain('builds a schema')
    }
  })

  it('answers the action built from the same schema', async () => {
    const { castVerdict } = await import(join(import.meta.dir, 'fixtures/shared-schema/src/routes/index.kay')) as { castVerdict: Action<{ choice: 'smash' | 'pass' }, string> }

    expect(await site.call(castVerdict, { choice: 'pass' })).toBe('pass')
    await site.refusal(castVerdict, { choice: 'maybe' } as unknown as { choice: 'pass' })
  })

  it('types a module reading an action\'s input and an island reading the schema\'s type', async () => {
    const root = await fixtureCopy('shared-schema')

    expect((await kayCheck([root])).code).toBe(0)
  }, 60_000)
})
