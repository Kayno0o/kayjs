import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { kayCheck } from './check-helper'
import { fixtureCopy } from './scratch'

const site = await testSite({ root: 'tests/fixtures/shared-schema' })

afterAll(async () => site.close())

describe('a schema shared by a server module and an island', () => {
  // The production client build the site makes refuses to finish when an island bundles `s`, so a page with its island is the proof.
  it('builds an island reading only the schema\'s type', async () => {
    const response = await site.fetch('/')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('class="flip"')
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
