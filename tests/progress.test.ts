import type { BuildProgress } from '../src/build/pipeline'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { encodePng } from '../src/server/png'
import { scratchDir } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const root = await scratchDir('progress-')

  dirs.push(root)
  await Promise.all([
    Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false }\n'),
    Bun.write(join(root, 'src/routes/index.kay'), '--- server\nexport const page = { prerender: true }\n---\n---\nimport { image } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\nimg({...image(hero, { sizes: \'100vw\' })} alt="Hero")\n'),
    Bun.write(join(root, 'src/routes/about.kay'), '--- server\nexport const page = { prerender: true }\n---\np About\n'),
    Bun.write(join(root, 'src/hero.png'), encodePng(new Uint8Array(96 * 64 * 4).fill(200), 96, 64)),
  ])

  return root
}

describe('kay build\'s progress', () => {
  it('goes through each step, the routes and images counted up to their total', async () => {
    const root = await project()
    const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\nconst steps = []\nconst { failed } = await buildProject(${JSON.stringify(root)}, { favicon: false }, { check: false, onProgress: progress => steps.push(progress) })\n\nconsole.log(JSON.stringify({ failed, steps }))\n`
    const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const { failed, steps } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { failed?: unknown, steps: BuildProgress[] }
    const routes = steps.filter(step => step.unit === 'routes')
    const images = steps.filter(step => step.unit === 'images')

    expect(failed, stderr).toBeUndefined()
    expect([...new Set(steps.map(step => step.step))]).toEqual(['bundling', 'encoding images', 'prerendering', 'writing images, cards and favicons', 'compressing'])
    expect(routes.map(step => `${step.done}/${step.total}`)).toEqual(['0/2', '1/2', '2/2'])
    expect(images.at(-1)).toEqual({ step: 'encoding images', done: 1, total: 1, unit: 'images' })
  }, 30_000)

  it('prints no control code when its output is piped', async () => {
    const root = await project()
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(code, stderr).toBe(0)
    expect(stdout).toStartWith('built 0 islands, 0 stylesheets and 2 prerendered pages in ')
    expect([...`${stdout}${stderr}`].filter(character => character === '\r' || character === '\x1B')).toEqual([])
  }, 30_000)
})
