import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

// A schedule in a file of `src/plugins`, which kay mounts as it mounts a plugin of the config, here through a plugin's own `.use`.
const root = await fixtureCopy('bare')

await Bun.write(join(root, 'src/plugins/tick.ts'), `import { Elysia } from 'elysia'\nimport { schedule } from 'kay/server'\n\nexport const ticks: number[] = []\n\nexport default new Elysia({ name: 'tick' }).use(schedule('1m', async () => void ticks.push(Date.now())))\n`)

const site = await testSite({ root, islands: false })

afterAll(async () => {
  await site.close()
})

it('fires a schedule a plugin file mounts through .use', async () => {
  const { ticks } = await import(resolve(root, 'src/plugins/tick.ts')) as { ticks: number[] }

  expect(await site.runSchedule('1m')).toBe(1)
  expect(await site.advance('3m')).toBe(3)
  expect(ticks).toHaveLength(4)
})
