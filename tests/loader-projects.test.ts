import type { JSX } from '../src/runtime/jsx'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { loaderLoaded, registerEarlyLoader, registerLoader } from '../src/server/loader'
import { renderToString } from '../src/server/string'
import { scratchDir } from './scratch'

const roots: string[] = []

const LIBRARY: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' }, kay: { settings: './src/settings' } }),
  'src/settings.ts': 'export default { icon: (name: string) => `default:${name}` }\n',
  'src/badge.kay': '---\nimport settings from \'./settings\'\n\nconst { label } = props<{ label: string }>()\n---\nspan {label} {settings.icon(label)}\n',
}

// A project with the library installed under its own `node_modules`, setting its icon to `icon` when given.
async function project(name: string, icon?: string): Promise<string> {
  const root = await scratchDir(`loader-${name}-`)
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name, private: true }),
    'kay.config.ts': icon === undefined ? 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n' : 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ settings: { \'kay-lib\': \'./src/ui-settings.ts\' } })\n',
    'src/own.kay': `p ${name}\n`,
    ...Object.fromEntries(Object.entries(LIBRARY).map(([file, text]) => [`node_modules/kay-lib/${file}`, text])),
  }

  if (icon !== undefined)
    files['src/ui-settings.ts'] = `export default { icon: (name: string) => \`${icon}:\${name}\` }\n`

  await Promise.all(Object.entries(files).map(async ([file, text]) => Bun.write(join(root, file), text)))
  roots.push(root)

  return root
}

async function badge(root: string): Promise<string> {
  const { default: Badge } = await import(join(root, 'node_modules/kay-lib/src/badge.kay')) as { default: (props: { label: string }) => JSX.Element }

  return renderToString(Badge, { label: 'hi' })
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises')

  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('the .kay loader with several projects', () => {
  it('loads the modules of two projects with different library settings in one process, each against its own project', async () => {
    const [a, b, c] = await Promise.all([project('a', 'app-a'), project('b', 'app-b'), project('c')])

    await registerLoader(a)
    await registerLoader(b)
    await registerLoader(c)

    expect(await badge(a)).toContain('hi app-a:hi')
    expect(await badge(b)).toContain('hi app-b:hi')
    expect(await badge(c)).toContain('hi default:hi')
    // Each project compiled into its own cache.
    expect([a, b, c].map(root => existsSync(join(root, '.kay/cache')))).toEqual([true, true, true])
  })

  it('keeps a plugin other code registered, and loads a project registered after it', async () => {
    plugin({ name: 'marker', setup: (build) => {
      build.onLoad({ filter: /\.marker$/ }, () => ({ contents: 'export default 42', loader: 'js' }))
    } })

    const root = await project('d', 'app-d')
    const file = join(root, 'thing.marker')

    await Bun.write(file, '')
    await registerLoader(root)

    expect(await badge(root)).toContain('hi app-d:hi')
    expect((await import(file) as { default: number }).default).toBe(42)
  })

  it('starts over from a guess with other settings, keeping the plugins other code registered and the projects loaded since', async () => {
    plugin({ name: 'marker-start-over', setup: (build) => {
      build.onLoad({ filter: /\.again$/ }, () => ({ contents: 'export default 7', loader: 'js' }))
    } })

    const [guessed, other] = await Promise.all([project('f', 'app-f'), project('g', 'app-g')])
    const file = join(guessed, 'thing.again')

    await Bun.write(file, '')
    await registerEarlyLoader(guessed)
    await registerLoader(other)
    await registerLoader(guessed, {})

    expect(await badge(guessed)).toContain('hi default:hi')
    expect(await badge(other)).toContain('hi app-g:hi')
    expect((await import(file) as { default: number }).default).toBe(7)
  })

  it('loads a project again for the same settings, and refuses other settings for a root already loaded', async () => {
    const root = await project('e', 'app-e')

    await registerLoader(root)
    await registerLoader(root)
    await registerLoader(root, { 'kay-lib': './src/ui-settings.ts' })

    await expect(registerLoader(root, {})).rejects.toThrow('other library settings')
  })

  it('settles a guess for concurrent calls once, whatever the settings they name', async () => {
    const root = await project('h', 'app-h')

    await registerEarlyLoader(root)
    await Promise.all([registerLoader(root, {}), registerLoader(root, {})])

    expect(loaderLoaded(root)).toBe(true)
    expect(await badge(root)).toContain('hi default:hi')
  })
})
