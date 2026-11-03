import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedLifetimes } from '../src/check/deprecated-lifetimes'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('lifetimes-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-lifetimes', () => {
  it('renames a page\'s revalidate, a notification\'s keep and a queue\'s or workflow\'s keepFailed, and leaves what is not kay\'s', async () => {
    const page = '--- server\nexport const page = { prerender: true, revalidate: \'1h\' }\n---\nh1 News\n'
    const layout = '--- server\nexport const page = { revalidate: \'5m\' } satisfies PageSettings\n---\nslot\n'
    const server = 'import { notify, queue, workflow } from \'kay/server\'\n\nawait notify(\'ada\', { title: \'x\', keep: \'7d\' })\nexport const mail = queue(\'mail\', () => undefined, { keepFailed: \'7d\' })\nexport const flow = workflow(\'flow\', () => undefined, { keepFailed })\n'
    const fence = '--- server\nawait notify(\'ada\', { title: \'x\', keep: \'7d\' })\n---\np x\n'
    const own = 'import { notify } from \'./mine\'\nimport * as kay from \'kay/server\'\n\nawait notify(\'ada\', { keep: 1 })\nexport const other = { revalidate: 1, keepFailed: 1 }\nexport const q = kay.queue(\'q\', () => undefined, { keepFailed: false })\n'
    const clash = '--- server\nexport const page = { revalidate: \'1h\', ttl: \'2h\' }\n---\np x\n'
    const root = await project({ 'src/routes/news.kay': page, 'src/routes/_layout.kay': layout, 'src/jobs.ts': server, 'src/routes/fence.kay': fence, 'src/own.ts': own, 'src/routes/clash.kay': clash })

    try {
      const found = await deprecatedLifetimes(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes === undefined]).sort()).toEqual([
        ['src/jobs.ts', 3, false],
        ['src/jobs.ts', 4, false],
        ['src/jobs.ts', 5, false],
        ['src/own.ts', 6, false],
        ['src/routes/_layout.kay', 2, false],
        ['src/routes/clash.kay', 2, true],
        ['src/routes/fence.kay', 2, false],
        ['src/routes/news.kay', 2, false],
      ])
      expect(found.find(diagnostic => diagnostic.file.endsWith('news.kay'))!.message).toContain('`revalidate` of a page\'s settings is `ttl` since 1.87')

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/news.kay')).text()).toBe(page.replace('revalidate', 'ttl'))
      expect(await Bun.file(join(root, 'src/routes/_layout.kay')).text()).toBe(layout.replace('revalidate', 'ttl'))
      expect(await Bun.file(join(root, 'src/jobs.ts')).text()).toBe(server.replace('keep:', 'ttl:').replace('keepFailed: \'7d\'', 'failedTtl: \'7d\'').replace('{ keepFailed }', '{ failedTtl: keepFailed }'))
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe(fence.replace('keep:', 'ttl:'))
      expect(await Bun.file(join(root, 'src/routes/clash.kay')).text()).toBe(clash)
      expect((await deprecatedLifetimes(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/routes/clash.kay'])
      expect(await deprecatedLifetimes(root, { lints: { 'deprecated-lifetimes': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
