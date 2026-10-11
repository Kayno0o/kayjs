import { $ } from 'bun'
import { expect, it } from 'bun:test'

// Spelled in parts so this file does not match itself.
const privateDomain = ['kevyn', 'fr'].join('.')

it('names the forge and registry under kaynooo.fr only, a lockfile\'s tarball URLs included', async () => {
  const grep = await $`git grep -lIiF ${privateDomain}`.nothrow().quiet()

  // git grep exits 1 when nothing matches; anything above means it could not search at all.
  expect(grep.exitCode).toBeLessThanOrEqual(1)
  expect(grep.text().split('\n').filter(Boolean)).toEqual([])
})
