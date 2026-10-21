import type { ClientBuild } from '../src/server/client'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { modeOf, resolveProject } from '../src/project'
import { logSink, setLogSink } from '../src/runtime/log'
import { servePages } from '../src/server/app'
import { fixtureCopy } from './scratch'

// Many arbitrary values, each its own rule, so the app's stylesheet passes what a head may inline and a page carries only the rules it names.
const BULK = Array.from({ length: 1800 }, (_, index) => `bg-[#${((index * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}] p-[${index + 3}px]`).join(' ')
const STYLE = /<style>([\s\S]*?)<\/style>/g

// The app's own rules for classes a script builds: nested as the maze of the playground writes them, a compound selector, `@apply` inside, in a utilities layer.
const MAZE_CSS = `@reference "../../app.css";

@layer utilities {
  .maze {
    @apply border-collapse;

    td {
      @apply border-0;

      &.explored {
        @apply bg-red-200;
      }

      &.t {
        @apply border-t-2;
      }

      &.s,
      &.e {
        @apply relative;

        &.side-1::after {
          content: '';
        }
      }
    }
  }
}

.plain td.wall { border-top: 2px solid; }
`
const MAZE_TS = `export class Maze {
  cellClasses(): string[] {
    const cls: string[] = []

    cls.push('t')
    cls.push(\`s side-\${1}\`)
    cls.push('explored')

    return [cls.join(' ')]
  }
}
`
const GROWING_TS = 'import { Maze } from \'./maze\'\n\nexport class GrowingTreeMaze extends Maze {}\n'
const MAZE_KAY = `---
import { memo, signal } from 'kay'
import { GrowingTreeMaze } from '../../scripts/growing'
import './maze.css'

const maze = signal(new GrowingTreeMaze())
const classes = memo(() => maze().cellClasses())
---
table.maze
  tr
    td(class={classes()[0]}) cell
`
const PAGE = '---\nimport Maze from \'../components/maze/maze.kay\'\n---\nh1 Maze\nMaze\n'
// A class a template builds in a server page, and one an island's module pushes while the page only imports a stylesheet declaring both.
const SERVER_CSS = '.board td.wall { border-top: 2px solid; }\n.board td.open { border-top: 0; }\n'
const SERVER_PAGE = '--- server\nimport \'../board.css\'\nconst cell = [\'wa\', \'ll\'].join(\'\')\n---\ntable.board\n  tr\n    td(class={cell}) cell\n'
const FILES: Record<string, string> = {
  'routes/bulk.kay': `h1 Bulk\np(class="${BULK}") bulk\n`,
  'components/maze/maze.css': MAZE_CSS,
  'scripts/maze.ts': MAZE_TS,
  'scripts/growing.ts': GROWING_TS,
  'components/maze/maze.kay': MAZE_KAY,
  'routes/maze.kay': PAGE,
  'board.css': SERVER_CSS,
  'routes/board.kay': SERVER_PAGE,
}

interface App {
  client: ClientBuild
  warned: string[]
  dir: string
  head: (path: string) => Promise<string>
  done: () => Promise<void>
}

const dirs: string[] = []

// A copy of the fixture with the files given, built for production with Tailwind, and a server reading its heads.
async function app(files: Record<string, string> = FILES, base = ''): Promise<App> {
  const dir = resolve(await fixtureCopy('page-styles'))
  const warned: string[] = []
  const previous = logSink()

  dirs.push(dir)

  for (const [path, text] of Object.entries(files))
    await Bun.write(join(dir, 'src', path), text)

  setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

  try {
    const client = await buildClient(dir, { plugins: [tailwind], ...(base === '' ? {} : { base }) })
    // One process serves one project, so only the shared app has a server.
    const head = async (path: string) => {
      const project = resolveProject(dir, { routes: 'src/routes', compress: false, ...(base === '' ? {} : { base }) }, modeOf({ dev: false, prebuilt: true }))
      const server = await servePages(project, () => ({ ...client, styles: new Map(client.styles), inlineStyles: undefined, inlineSizes: undefined, pageStyles: undefined }))
      const html = await (await server.handle(new Request(`http://localhost${base}${path}`))).text()

      return [...html.matchAll(STYLE)].map(match => match[1]!).join('\n')
    }

    return { client, dir, warned, head, done: async () => rm(dir, { recursive: true, force: true }) }
  }
  finally {
    if (previous)
      setLogSink(previous)
    else
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]
  }
}

const has = (css: string, selector: string) => css.includes(selector)

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

let shared: Promise<App> | undefined
const sharedApp = async () => shared ??= app()

const carriedBy = (built: App, route: string) => (built.client.styleUses!.entries.get(join(built.dir, `src/routes/${route}.kay`)) as number[]).map(index => built.client.styleUses!.classes[index]!)

describe('the app\'s own stylesheet rules, for classes a script builds', () => {
  it('keeps them in the head of the page whose island imports the stylesheet, with no @source inline and no warning', async () => {
    const built = await sharedApp()
    const css = await built.head('/maze')

    // A compound selector, the nested forms, `@apply` inside, and a class pushed in a plain module an island imports.
    for (const selector of ['td.t', 'td.explored', 'side-1', '.plain td.wall'])
      expect(has(css, selector), selector).toBe(true)

    expect(has(css, 'p-[')).toBe(false)
    expect(built.warned).toEqual([])
  }, 120_000)

  it('keeps them when a plain module imports the stylesheet instead of the island', async () => {
    const built = await app({ ...FILES, 'scripts/growing.ts': `import '../components/maze/maze.css'\n${GROWING_TS}`, 'components/maze/maze.kay': MAZE_KAY.replace('import \'./maze.css\'\n', '') })
    const names = carriedBy(built, 'maze')

    for (const name of ['t', 'explored', 'wall'])
      expect(names, name).toContain(name)

    expect(built.warned).toEqual([])
  }, 120_000)

  it('keeps them for a class a server page builds in a template expression, with no warning', async () => {
    const built = await sharedApp()
    const css = await built.head('/board')

    expect(has(css, '.board td.wall')).toBe(true)
    expect(has(css, '.board td.open')).toBe(true)
    expect((built.client.unresolved ?? []).filter(found => found.file.endsWith('board.kay'))).toEqual([])
  }, 120_000)

  it('keeps the rule of a class both Tailwind and the app\'s stylesheet name, and the app\'s alongside Tailwind\'s', async () => {
    const built = await app({ ...FILES, 'components/maze/maze.css': `${MAZE_CSS}.maze .underline { color: red; }\n`, 'components/maze/maze.kay': MAZE_KAY.replace('table.maze', 'table.maze.underline') })

    expect(carriedBy(built, 'maze')).toContain('underline')
    expect(built.warned).toEqual([])
  }, 120_000)

  it('keeps them under a mount point', async () => {
    const built = await app(FILES, '/play')
    const names = carriedBy(built, 'maze')

    for (const name of ['t', 'explored', 'side-1', 'wall'])
      expect(names, name).toContain(name)

    expect(built.warned).toEqual([])
  }, 120_000)

  it('still warns of a value read from nothing when no stylesheet the file reaches names it', async () => {
    const built = await app({ ...FILES, 'components/maze/maze.kay': MAZE_KAY.replace('import \'./maze.css\'\n', '').replace('import { GrowingTreeMaze } from \'../../scripts/growing\'', 'import { GrowingTreeMaze } from \'../../scripts/growing\'\nimport \'../../app.css\'') })

    expect(built.warned).toHaveLength(1)
    expect(built.warned[0]).toContain('island src/components/maze/maze.kay')
  }, 120_000)
})
