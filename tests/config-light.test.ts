import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { scratchDir } from './scratch'

const LOADER_MODULE = resolve(import.meta.dir, '../src/config-loader.ts')

// Loads the config in a fresh process and says whether the server's entry was loaded with it.
async function serverLoadedBy(source: string): Promise<{ serverLoaded: boolean, site: unknown }> {
  const dir = resolve(await scratchDir('config-light-'))

  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, 'kay.config.ts'), source)
  await Bun.write(join(dir, 'probe.ts'), `import { loadConfig } from ${JSON.stringify(LOADER_MODULE)}\nconst config = await loadConfig(${JSON.stringify(dir)})\nconsole.log(JSON.stringify({ serverLoaded: Object.keys(require.cache).some(path => path.endsWith('/src/server/index.ts')), site: config.site }))\n`)

  const child = Bun.spawn([process.execPath, join(dir, 'probe.ts')], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  expect(code).toBe(0)

  return JSON.parse(out) as { serverLoaded: boolean, site: unknown }
}

test('a config importing only defineConfig loads without the server', async () => {
  const loaded = await serverLoadedBy(`import { defineConfig } from 'kay/server'\nexport default defineConfig({ site: 'https://a.test' })\n`)

  expect(loaded).toEqual({ serverLoaded: false, site: 'https://a.test' })
})

test('a config importing anything else from kay/server loads the server', async () => {
  const loaded = await serverLoadedBy(`import { defineConfig, Elysia } from 'kay/server'\nvoid Elysia\nexport default defineConfig({ site: 'https://b.test' })\n`)

  expect(loaded).toEqual({ serverLoaded: true, site: 'https://b.test' })
})

test('a config naming the import in a string or a comment loads, and loads the server when a string holds the only match', async () => {
  const loaded = await serverLoadedBy(`import { defineConfig } from 'kay/server'\n// import { defineConfig } from 'kay/server'\nconst doc = "import { defineConfig } from 'kay/server'"\nexport default defineConfig({ site: doc })\n`)

  expect(loaded.site).toBe(`import { defineConfig } from 'kay/server'`)
})

test('a config importing an export a library removed names the export and the note that replaces it', async () => {
  const dir = resolve(await scratchDir('config-removed-'))

  await mkdir(join(dir, 'lib'), { recursive: true })
  await Bun.write(join(dir, 'lib/index.ts'), 'export const mail = 1\n')
  await Bun.write(join(dir, 'kay.config.ts'), `import { mailExtension } from './lib/index.ts'\nexport default { site: String(mailExtension) }\n`)
  await Bun.write(join(dir, 'probe.ts'), `import { loadConfig } from ${JSON.stringify(LOADER_MODULE)}\ntry { await loadConfig(${JSON.stringify(dir)}) } catch (error) { console.log(String(error instanceof Error ? error.message : error)) }\n`)

  const child = Bun.spawn([process.execPath, join(dir, 'probe.ts')], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(child.stdout).text()

  expect(out).toContain('imports `mailExtension` from')
  expect(out).toContain('use mail({ module })')
  expect(out).toContain('llms/upgrading.md')
  expect(out).not.toContain('SyntaxError')
})
