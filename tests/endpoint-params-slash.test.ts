import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

it('hands an endpoint its path value decoded once, with a suffix and a trailing slash', async () => {
  const root = await fixtureCopy('routing')

  await Bun.write(join(root, 'src/routes/e/[name].json.ts'), 'export function GET({ params }: { params: { name: string } }) { return params.name }\n')
  await Bun.write(join(root, 'src/routes/p/[name].txt.ts'), 'export function GET({ params }: { params: { name: string } }) { return params.name }\n')

  const site = await testSite({ root, base: '/shop', trailingSlash: 'always' })

  try {
    expect(await (await site.fetch('/e/a%2Fb.json')).text()).toBe('a/b')
    expect(await (await site.fetch('/e/%252F.json')).text()).toBe('%2F')
    expect(await (await site.fetch('/p/a%2Fb.txt/')).text()).toBe('a/b')
  }
  finally {
    await site.close()
  }
})
