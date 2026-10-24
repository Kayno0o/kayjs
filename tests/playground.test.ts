import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { highlight } from '../docs/src/highlight'
import { runs } from '../docs/src/playground/check'
import { isRunnable, playgroundHref, sourceOfHash } from '../docs/src/playground/runnable'
import { stripTypes } from '../docs/src/playground/strip'
import { compileKay } from '../src/compiler'
import { scratchDir } from './scratch'

const root = join(import.meta.dir, '..')
const pagesDir = join(root, 'docs/src/content/docs')
const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
// The scope attribute a `--- style` fence writes, whose hash is Bun's on the server and the browser build's own.
const SCOPE = /data-k-[0-9a-z]{8}/g

const examples = (await Promise.all([...new Bun.Glob('**/*.md').scanSync(pagesDir)].toSorted().map(async file => [...(await Bun.file(join(pagesDir, file)).text()).matchAll(KAY_BLOCK)].map((match, index) => [`${file} #${index + 1}`, match[1]!] as const)))).flat()
const runnable = examples.filter(([, source]) => runs(source))

let browserCompile: typeof import('../docs/src/playground/compile').compile

// The compiler as the docs ship it to a browser, bundled for one with the stand-ins of `host.browser.ts`, and run here.
beforeAll(async () => {
  const dir = await scratchDir('playground-')
  const built = await Bun.build({ entrypoints: [join(root, 'docs/src/playground/compile.ts')], target: 'browser', outdir: dir })

  expect(built.success, built.logs.join('\n')).toBe(true)
  browserCompile = (await import(built.outputs[0]!.path) as { compile: typeof browserCompile }).compile
}, 120_000)

describe('the playground\'s compiler', () => {
  it('finds runnable examples among the docs\' and leaves the ones with a server fence out', () => {
    expect(runnable.length).toBeGreaterThan(40)
    expect(examples.filter(([, source]) => (/^--- server/m).test(source)).every(([, source]) => !isRunnable(source))).toBe(true)
    expect(isRunnable('---\nimport { signal } from \'kay\'\n---\np hi')).toBe(true)
    expect(isRunnable('---\nimport x from \'./x.kay\'\n---\nx')).toBe(false)
    expect(isRunnable('---\nimport { t } from \'kay/i18n\'\n---\np {t(\'a\')}')).toBe(false)
    expect(runs('---\nconst a = props.nothing.deep\n---\np {a}\n')).toBe(false)
    expect(isRunnable('markdown\n  # hi')).toBe(false)
  })

  it.each(runnable)('%s compiles in the browser build to the code the server compiler writes', (_name, source) => {
    const result = browserCompile(source)

    expect(result.problems.map(problem => problem.report)).toEqual([])

    for (const output of ['html', 'dom'] as const) {
      const expected = stripTypes(compileKay(source, '/playground.kay', { root: '/', output }).tsx)

      expect((output === 'html' ? result.server : result.dom)?.replace(SCOPE, 'data-k')).toBe(expected.replace(SCOPE, 'data-k'))
    }
  })

  it('reports a compile error at its line', () => {
    const { problems, server } = browserCompile('---\nimport { signal } from \'kay\'\nconst n = signal(0)\n---\np Count\ndiv(\n  p {n(}\n')

    expect(server).toBeUndefined()
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.map(problem => problem.line)).toContain(7)
    expect(problems[0]!.report).toContain('playground.kay')
  })

  it('holds a source in a link\'s fragment and reads it back', () => {
    const source = '---\nconst a = \'é€\'\n---\np {a}\n'

    expect(sourceOfHash(playgroundHref(source).slice(playgroundHref(source).indexOf('#')))).toBe(source)
    expect(sourceOfHash('#other')).toBeUndefined()
  })
})

describe('the docs\' examples', () => {
  it('link a runnable one to the playground and leave an unrunnable one without', async () => {
    const withLink = await highlight('---\nimport { signal } from \'kay\'\nconst n = signal(0)\n---\nbutton(onClick={() => n.update(c => c + 1)}) {n()}\n', 'kay')
    const withServer = await highlight('--- server\nconst data = { a: 1 }\n---\np {data.a}\n', 'kay')
    const typescript = await highlight('const a = 1\n', 'typescript')

    expect(withLink).toContain('href="/getting-started/playground#code=')
    expect(withServer).not.toContain('playground')
    expect(typescript).not.toContain('playground')
  })
})
