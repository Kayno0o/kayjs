import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { budgetLints, checkBudget } from '../src/build/budget'
import { byteSize } from '../src/runtime/byte-size'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const roots: string[] = []

// Random text compresses badly, so the module weighs about what it is long.
const NOISE = Array.from({ length: 4000 }, (_, index) => `'${Bun.hash(String(index)).toString(36)}${Bun.hash(`n${index}`).toString(36)}'`).join(',')

async function project(config: string): Promise<string> {
  const root = await scratchDir('budget-')
  const files: Record<string, string> = {
    'tsconfig.json': TSCONFIG,
    'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, ${config} })\n`,
    'src/words.ts': `export const words = [${NOISE}]\n`,
    'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { words } from \'./words\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {words[n()]} {n()}\n',
    'src/light.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
    'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    'src/routes/plain.kay': 'p Plain\n',
    'src/routes/styled.kay': '---\nimport \'../note.css\'\n---\np.note Styled\n',
    'src/note.css': '.note { color: rebeccapurple; margin: 0 auto; padding: 1rem 2rem; border: 1px solid #123456 }\n',
  }

  roots.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function built(root: string, ...args: string[]) {
  const { code, report, output: err } = await kayBuild([root, '--no-check', '--format', 'json', ...args])
  const document = JSON.parse(report) as { problems: { code: string, message: string, note?: string, severity?: string }[], built?: { sizes?: { islands: { modules?: unknown }[] } } }

  return { code, err, document, over: document.problems.filter(problem => problem.code === 'over-budget') }
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('byteSize', () => {
  it('reads bytes and a number with its unit, and refuses anything else', () => {
    expect(byteSize('20kb', 'x')).toBe(20_480)
    expect(byteSize('1.5MB', 'x')).toBe(1_572_864)
    expect(byteSize('800b', 'x')).toBe(800)
    expect(byteSize(500, 'x')).toBe(500)

    for (const bad of ['20', '20 kb', 'kb', '-1kb', 0, Number.NaN, '0kb', undefined])
      expect(() => byteSize(bad, '`budget.js`')).toThrow('`budget.js`')
  })
})

describe('budgetLints', () => {
  const sizes = [{ route: '/', js: 30_000, css: 12_000, islands: ['a.kay'], pages: 1, kept: 0, estimated: false }, { route: '/b', js: 1000, css: 100, islands: [], pages: 0, kept: 0, estimated: true }]
  const routes = [{ pattern: '/', file: 'src/routes/index.kay', layouts: [] }, { pattern: '/b', file: 'src/routes/b.kay', layouts: [] }] as never

  it('refuses a weight that is no positive size and a grade that is no letter from A to G, where kay check reads them', () => {
    expect(() => checkBudget({ weight: '500kb', grade: 'C' })).not.toThrow()
    expect(() => checkBudget(undefined)).not.toThrow()

    for (const weight of ['0', '-1kb', '1e3kb', '20 kb', '', 'heavy'])
      expect(() => checkBudget({ weight: weight as never })).toThrow('`budget.weight`')

    for (const grade of ['H', 'a', '', 'AA'])
      expect(() => checkBudget({ grade: grade as never })).toThrow('`budget.grade`')
  })

  it('reports each route and kind over its limit at the route\'s file, and nothing without a budget', () => {
    expect(budgetLints(undefined, undefined, sizes, routes, undefined)).toEqual([])
    expect(budgetLints({ js: '20kb', css: '10kb' }, undefined, sizes, routes, undefined).map(each => [each.file, each.severity, each.message])).toEqual([
      ['src/routes/index.kay', 'warning', '`/` loads 29.3 KB of JavaScript, over the budget of 20.0 KB'],
      ['src/routes/index.kay', 'warning', '`/` loads 11.7 KB of CSS, over the budget of 10.0 KB'],
    ])
    expect(budgetLints({ js: 500 }, undefined, sizes, routes, undefined).map(each => each.message)).toEqual([expect.stringContaining('`/` loads'), expect.stringContaining('`/b` can load')])
  })

  it('names the modules of the entry and the route\'s islands, and follows the lint\'s level', () => {
    const report = { entry: { size: { raw: 1, gzip: 1 }, modules: [{ name: 'kay/runtime', bytes: 2048 }] }, islands: [{ file: 'a.kay', size: { raw: 1, gzip: 1 }, modules: [{ name: 'dayjs', bytes: 9216 }] }, { file: 'other.kay', size: { raw: 1, gzip: 1 }, modules: [{ name: 'lodash', bytes: 90_000 }] }] }
    const [found] = budgetLints({ js: '20kb' }, { 'over-budget': 'deny' }, sizes, routes, report)

    expect(found!.severity).toBe('error')
    expect(found!.note).toBe('compressed; the modules weighing most, minified: dayjs 9.0 KB, kay/runtime 2.0 KB')
    expect(budgetLints({ js: '20kb' }, { 'over-budget': 'allow' }, sizes, routes, report)).toEqual([])
    expect(budgetLints({ js: '20kb' }, { code: 'allow' }, sizes, routes, report)).toEqual([])
  })
})

describe('kay build with a budget', () => {
  it('prints the modules under --analyze only, measures nothing for an allowed lint, and keeps a route with no JavaScript out', async () => {
    const analyzed = await built(await project('budget: { js: \'2kb\' }'), '--analyze')

    expect(analyzed.document.built!.sizes!.islands.some(island => island.modules !== undefined)).toBe(true)
    expect(analyzed.over.map(problem => problem.message)).toEqual([expect.stringContaining('`/` can load')])

    const allowed = await built(await project('budget: { js: \'2kb\' }, lints: { \'over-budget\': \'allow\' }'))

    expect(allowed.document.built!.sizes!.islands.every(island => island.modules === undefined)).toBe(true)
  }, 120_000)

  it('reports a css budget, and refuses a limit that is no positive size whatever the lint\'s level', async () => {
    const css = await built(await project('budget: { css: \'1b\' }'))

    expect(css.over.map(problem => problem.message)).toEqual([expect.stringContaining('of CSS, over the budget of 0.0 KB')])
    expect(css.over[0]!.message).toContain('`/styled`')

    const bad = await built(await project('budget: { js: \'20 kb\' }, lints: { \'over-budget\': \'allow\' }'))

    expect(bad.code).toBe(1)
    expect(bad.document.problems.map(problem => problem.message).join('\n')).toContain('`budget.js` is \'20 kb\'')
  }, 120_000)

  it('has --deny-warnings fail on a check warning with no budget set', async () => {
    const root = await project('')

    await Bun.write(join(root, 'src/routes/clicks.kay'), 'p Press <kbd>Ctrl</kbd>\n')

    const { code, output: err } = await kayBuild([root, '--deny-warnings'])

    expect(err).toContain('failing under --deny-warnings')
    expect(code).toBe(1)
  }, 120_000)

  it('warns of a page over budget.js with its heaviest modules, leaves --analyze\'s breakdown out of the report, and passes under a larger budget', async () => {
    const root = await project('budget: { js: \'2kb\' }')
    const { code, err, document, over } = await built(root)

    expect([code, err]).toEqual([0, ''])
    expect(over.map(problem => problem.severity)).toEqual(['warning'])
    expect(over[0]!.message).toContain('`/` can load')
    expect(over[0]!.note).toContain('src/words.ts')
    expect(document.built!.sizes!.islands.every(island => island.modules === undefined)).toBe(true)

    const roomy = await built(await project('budget: { js: \'500kb\', css: \'500kb\' }'))

    expect(roomy.over).toEqual([])
  }, 120_000)

  it('fails under --deny-warnings or a lint set to deny, and reports nothing when the lint is allowed', async () => {
    const root = await project('budget: { js: \'2kb\' }')

    expect((await built(root, '--deny-warnings')).code).toBe(1)

    const denied = await built(await project('budget: { js: \'2kb\' }, lints: { \'over-budget\': \'deny\' }'))

    expect([denied.code, denied.over.map(problem => problem.severity)]).toEqual([1, ['error']])
    expect((await built(await project('budget: { js: \'2kb\' }, lints: { \'over-budget\': \'allow\' }'))).over).toEqual([])
  }, 120_000)
})
