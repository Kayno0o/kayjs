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
  it('posts them under a base, from a path and from a call', async () => {
    const mounted = await testSite({ root: 'tests/fixtures/form-fields', islands: false, base: '/blog' })
    const read = async () => Number((await mounted.visit('/lone')).find('p.tally')[0]?.text)
    const before = await read()

    await mounted.call(bump.with({ by: 4 }))
    await mounted.submit(bump.with({ by: 6 }), {}, { from: '/lone' })

    expect(await read()).toBe(before + 10)
    await mounted.close()
  })

  it('has call send the fields `with` fixes, as an island does', async () => {
    const before = await tally()

    await site.call(bump.with({ by: 5 }))

    expect(await tally()).toBe(before + 5)
  })

  it('has submit from a visited page post the form fixing the same fields', async () => {
    const before = await tally()
    const page = await site.visit('/lone')

    await site.submit(bump.with({ by: 2 }), {}, { from: page })
    await site.submit(bump, {}, { from: page })

    expect(await tally()).toBe(before + 3)
  })

  it('has submit from a path post them too', async () => {
    const before = await tally()

    await site.submit(bump.with({ by: 7 }), {}, { from: '/lone' })

    expect(await tally()).toBe(before + 7)
  })
})
