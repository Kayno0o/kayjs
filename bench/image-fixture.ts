import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERO = /src=%2F_kay%2Fassets%2F([^&]+)&amp;/

// A copy of the image test fixture in a directory of its own, so its build under `.kay/` races no test run, with `kay` resolving to this checkout.
export async function imageFixture(): Promise<{ root: string, dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'kay-image-bench-'))

  await cp(join(import.meta.dir, '../tests/fixtures/images/src'), join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules'))
  await symlink(join(import.meta.dir, '..'), join(root, 'node_modules/kay'), 'dir')

  return { root, dispose: async () => rm(root, { recursive: true, force: true }) }
}

// The image route and build file URLs of the fixture's imported image, read off its home page.
export function heroPaths(html: string): { image: string, asset: string } {
  const hero = decodeURIComponent(HERO.exec(html)![1]!)

  return { image: `/_kay/image?src=${encodeURIComponent(`/_kay/assets/${hero}`)}&w=320`, asset: `/_kay/assets/${hero}` }
}
