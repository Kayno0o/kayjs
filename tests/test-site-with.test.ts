import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/form-fields', islands: false })
const { bump } = await import(join(import.meta.dir, 'fixtures/form-fields/src/routes/lone.kay')) as { bump: Action<{ by?: number }, unknown> & { with: (fields: object) => Action<{ by?: number }, unknown> } }

afterAll(async () => {
  await site.close()
})

async function tally(): Promise<number> {
  return Number((await site.visit('/lone')).find('p.tally')[0]?.text)
}

describe('site.call and site.submit with an action fixing fields', () => {
  it('has call send the fields `with` fixes, as an island does', async () => {
    const before = await tally()

    await site.call(bump.with({ by: 5 }))

    expect(await tally()).toBe(before + 5)
  })

  it('has submit from a path post them too', async () => {
    const before = await tally()

    await site.submit(bump.with({ by: 7 }), {}, { from: '/lone' })

    expect(await tally()).toBe(before + 7)
  })
})
