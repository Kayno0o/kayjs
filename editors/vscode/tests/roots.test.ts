import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { registerCommands } from '../src/commands'
import { clientRoots, COMMANDS, holding, owns, rootOf, serverPath } from '../src/roots'

const has = (...paths: string[]) => (path: string): boolean => paths.includes(path)
const cli = (root: string): string => join(root, 'node_modules/kay/src/cli.ts')

describe('serverPath', () => {
  it('takes the configured path, absolute or relative to the workspace folder', () => {
    expect(serverPath('/w/app', '/w', '/opt/kay/cli.ts', has())).toBe('/opt/kay/cli.ts')
    expect(serverPath('/w/app', '/w', 'tools/cli.ts', has())).toBe('/w/tools/cli.ts')
  })

  it('finds the kay a monorepo hoists, looking up to the workspace folder and no further', () => {
    expect(serverPath('/w/apps/site', '/w', '', has(cli('/w')))).toBe(cli('/w'))
    expect(serverPath('/w/apps/site', '/w', '', has(cli('/w/apps/site'), cli('/w')))).toBe(cli('/w/apps/site'))
    expect(serverPath('/w/apps/site', '/w', '', has(cli('/')))).toBeUndefined()
  })

  it('falls back to the cli of the kay repository itself', () => {
    expect(serverPath('/kayjs', '/kayjs', '', has('/kayjs/src/cli.ts'))).toBe('/kayjs/src/cli.ts')
  })
})

describe('clientRoots', () => {
  it('serves every folder of a multi-root workspace holding a kay.config.ts', () => {
    const roots = clientRoots(['/a', '/b', '/c'], ['/a', '/c'], '', has(cli('/a'), cli('/b'), cli('/c')))

    expect(roots.map(({ root }) => root)).toEqual(['/a', '/b', '/c'])
  })

  it('serves a folder with no config for the kay it has installed, and skips one with neither', () => {
    expect(clientRoots(['/a', '/b'], [], '', has(cli('/a'))).map(({ root, config }) => [root, config])).toEqual([['/a', false]])
  })

  it('serves each app of a monorepo whose folder holds no config', () => {
    const roots = clientRoots(['/repo'], ['/repo/apps/a', '/repo/apps/b'], '', has(cli('/repo')))

    expect(roots.map(({ root, cli: found }) => [root, found])).toEqual([['/repo/apps/a', cli('/repo')], ['/repo/apps/b', cli('/repo')]])
  })

  it('serves a project nested in another with its own server', () => {
    expect(clientRoots(['/repo'], ['/repo/docs', '/repo'], '', has(cli('/repo'))).map(({ root }) => root)).toEqual(['/repo', '/repo/docs'])
  })

  it('keeps a project without kay in the list, with no cli, so the extension waits for it', () => {
    expect(clientRoots(['/a'], ['/a'], '', has())).toEqual([{ root: '/a', cli: undefined, config: true }])
  })
})

describe('rootOf', () => {
  it('names the deepest root holding a file', () => {
    expect(rootOf('/w/apps/a/src/x.kay', ['/w', '/w/apps/a'])).toBe('/w/apps/a')
    expect(rootOf('/w/apps/ab/x.kay', ['/w/apps/a'])).toBeUndefined()
  })
})

describe('owns', () => {
  const roots = ['/repo', '/repo/docs', '/repo/docs/deep']

  it('gives a file to the innermost root holding it, and only to that one', () => {
    expect(owns('/repo', '/repo/src/a.kay', roots)).toBe(true)
    expect(owns('/repo', '/repo/docs/a.kay', roots)).toBe(false)
    expect(owns('/repo/docs', '/repo/docs/a.kay', roots)).toBe(true)
    expect(owns('/repo/docs', '/repo/docs/deep/a.kay', roots)).toBe(false)
    expect(owns('/repo/docs/deep', '/repo/docs/deep/a.kay', roots)).toBe(true)
  })

  it('does not mistake a sibling sharing a name prefix for a nested project', () => {
    expect(owns('/repo', '/repo/docs-old/a.kay', roots)).toBe(true)
  })

  it('leaves a file to the outer root while the nested one is not served', () => {
    expect(owns('/repo', '/repo/docs/a.kay', ['/repo'])).toBe(true)
  })
})

describe('holding', () => {
  it('names the servers a started or stopped nested root takes files from', () => {
    expect(holding(['/repo', '/other'], ['/repo/docs'])).toEqual(['/repo'])
    expect(holding(['/repo', '/repo/docs'], ['/repo/docs'])).toEqual(['/repo'])
  })

  it('leaves the servers above the nearest one alone', () => {
    expect(holding(['/repo', '/repo/docs'], ['/repo/docs/deep'])).toEqual(['/repo/docs'])
  })
})

describe('commands', () => {
  it('registers every command of the manifest once, each with its own handler', async () => {
    const manifest = await Bun.file(join(import.meta.dir, '../package.json')).json() as { contributes: { commands: { command: string }[] } }
    const handlers = Object.fromEntries(COMMANDS.map(id => [id, () => id])) as Record<(typeof COMMANDS)[number], () => unknown>
    const registered = registerCommands((id, run) => ({ id, result: run() }), handlers)

    expect(manifest.contributes.commands.map(({ command }) => command).sort()).toEqual([...COMMANDS].sort())
    expect(registered).toEqual(COMMANDS.map(id => ({ id, result: id })))
  })
})
