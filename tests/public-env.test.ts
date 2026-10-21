import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { publicEnvFiles } from '../src/server/env-state'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const env = 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ MAP_KEY: s.Public(s.String()), SESSION_NOTE: s.String({ default: \'x\' }) }))\n'
const map = '---  client\nimport { publicEnv } from \'kay\'\n\nconst key = publicEnv.MAP_KEY\n---\np {key}\n'
const page = '--- server\nimport Map from \'../map.kay\'\n---\nMap\n'

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>, config = 'export default { favicon: false }\n'): Promise<string> {
  const root = await scratchDir('public-env-')

  dirs.push(root)
  await Promise.all(Object.entries({ 'kay.config.ts': config, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...process.env, NODE_ENV: 'development', ...extra }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('s.Public with no publicEnv in the config', () => {
  it.each(['', '/shop'])('is served from /_kay/env.js, imported by the client entry and exported by kay build --static, under base %p', async (base) => {
    const root = await project({ 'src/env.ts': env, 'src/map.kay': map, 'src/routes/index.kay': page }, `export default { favicon: false${base === '' ? '' : `, base: '${base}'`} }\n`)
    const served = await kay(['render', `${base}/_kay/env.js`], root, { MAP_KEY: 'pk-1' })

    expect(served.stdout).toBe('export default {"MAP_KEY":"pk-1"}\n')

    const built = await kay(['build', '.', '--no-check', '--static', '--outdir', 'out'], root, { MAP_KEY: 'pk-1' })

    expect(built.code, built.stderr).toBe(0)
    expect(await Bun.file(join(root, 'out/_kay/env.js')).text()).toBe('export default {"MAP_KEY":"pk-1"}\n')

    const scripts = (await readdir(join(root, 'out'), { recursive: true })).filter(file => file.endsWith('.js') && !file.includes('_kay/env'))
    const entries = await Promise.all(scripts.map(async file => Bun.file(join(root, 'out', file)).text()))

    expect(entries.some(text => text.includes(`${base}/_kay/env.js`))).toBe(true)
  }, 60_000)
})

describe('the scan for s.Public', () => {
  it('follows a file as it changes, and leaves out tests', async () => {
    const root = await project({ 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': env })

    expect(publicEnvFiles(root)).toEqual([])
    await Bun.write(join(root, 'src/a.ts'), env)
    expect(publicEnvFiles(root)).toEqual(['src/a.ts'])
    expect(publicEnvFiles(root)).toEqual(['src/a.ts'])
    await Bun.write(join(root, 'src/a.ts'), 'export const a = 12\n')
    expect(publicEnvFiles(root)).toEqual([])
  })
})
