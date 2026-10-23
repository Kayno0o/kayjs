import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const PLAIN = (slugs: string[]) => `--- server\nexport const page = { prerender: ${JSON.stringify(slugs.map(slug => ({ slug })))} }\n\nconst { slug } = ctx.params\n---\nh1 Post {slug}\n`
const REST = (slugs: string[]) => `--- server\nexport const page = { prerender: ${JSON.stringify(slugs.map(path => ({ path })))} }\n\nconst { path } = ctx.params\n---\nh1 File {path}\n`

// A project with its export in `site/out`, so a file written above `out` lands in `site` or the project, which the listing sees.
async function project(files: Record<string, string>, config = ''): Promise<{ dir: string, out: string }> {
  const dir = await scratchDir('static-hostile-')

  await Promise.all(Object.entries({ 'src/routes/index.kay': 'h1 Home\n', 'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ site: 'https://x.example', ${config} })\n`, ...files }).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  return { dir, out: join(dir, 'site/out') }
}

async function exported(dir: string, out: string) {
  return kayBuild([dir, '--no-check', '--static', '--outdir', out])
}

// Every file under the project except the export and what the build keeps under `.kay`.
async function outside(dir: string, out: string): Promise<string[]> {
  const found = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: dir, dot: true, onlyFiles: true }))

  return found.filter(file => !file.startsWith('.kay/') && !file.startsWith(`${relative(dir, out)}/`) && !file.startsWith('src/') && file !== 'kay.config.ts')
}

describe('kay build --static with a hostile slug', () => {
  it('refuses a plain param holding a slash, a backslash, a NUL or a dot segment, and writes nothing outside the output', async () => {
    for (const slug of ['a/../../x', 'a/b', '/etc', '../x', '..', 'a\\..\\x', 'a\0b']) {
      const { dir, out } = await project({ 'src/routes/posts/[slug].kay': PLAIN([slug]) })
      const { code, output } = await exported(dir, out)

      expect([JSON.stringify(slug), code]).toEqual([JSON.stringify(slug), 1])
      expect(output).toContain('which needs a string for each of slug')
      expect(await outside(dir, out)).toEqual([])
    }
  })

  it('refuses a catch-all segment that is a dot segment or holds a backslash or a NUL, and keeps its slashes', async () => {
    for (const path of ['a/../../x', 'a//b', '../x', 'a\\..\\x', 'a/b\0']) {
      const { dir, out } = await project({ 'src/routes/files/[...path].kay': REST([path]) })
      const { code, output } = await exported(dir, out)

      expect([JSON.stringify(path), code]).toEqual([JSON.stringify(path), 1])
      expect(output).toContain('which needs a string for each of path')
      expect(await outside(dir, out)).toEqual([])
    }
  })

  it('writes percent signs literally, so an encoded dot segment or slash stays a name inside the output', async () => {
    for (const config of ['', 'base: \'/repo\'']) {
      const { dir, out } = await project({ 'src/routes/posts/[slug].kay': PLAIN(['%2e%2e', '%2f', '%5c', 'a%2f..%2f..%2fx', 'fine']), 'src/routes/files/[...path].kay': REST(['docs/%2e%2e/%2e%2e/x', 'docs/guide']) }, config)
      const { code, output } = await exported(dir, out)

      expect([config, code, output]).toEqual([config, 0, expect.any(String)])
      expect(await outside(dir, out)).toEqual([])
      expect(existsSync(join(out, 'posts/fine.html'))).toBe(true)
      expect(existsSync(join(out, 'files/docs/guide.html'))).toBe(true)
      expect((await readdir(join(out, 'posts'))).filter(name => name.endsWith('.html')).toSorted()).toEqual(['%2e%2e.html', '%2f.html', '%5c.html', 'a%2f..%2f..%2fx.html', 'fine.html'])
    }
  })

  it('refuses a static file an extension names outside the output', async () => {
    const { dir, out } = await project({}, 'extensions: [{ name: \'leak\', staticFiles: { \'../evil.txt\': \'x\' } }]')
    const { code, output } = await exported(dir, out)

    expect(code).toBe(1)
    expect(output).toContain('would be written outside the output folder')
    expect(await outside(dir, out)).toEqual([])
  })
})
