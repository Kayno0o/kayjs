import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { highlight } from '../docs/src/highlight'
import { playgroundWarm } from '../docs/src/playground/bundles'
import { runs } from '../docs/src/playground/check'
import { isRunnable, playgroundHref, sourceOfHash } from '../docs/src/playground/runnable'
import { mount, renderServer } from '../docs/src/playground/runtime'
import { SAMPLE } from '../docs/src/playground/sample'
import { stripTypes } from '../docs/src/playground/strip'
import { watchdog } from '../docs/src/playground/watchdog'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { fixtureCopy, scratchDir } from './scratch'

const root = join(import.meta.dir, '..')
const pagesDir = join(root, 'docs/src/content/docs')
const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
// The scope attribute a `--- style` fence writes, whose hash is Bun's on the server and the browser build's own.
const SCOPE = /data-k-[0-9a-z]{8}/g

const examples = (await Promise.all([...new Bun.Glob('**/*.md').scanSync(pagesDir)].toSorted().map(async file => [...(await Bun.file(join(pagesDir, file)).text()).matchAll(KAY_BLOCK)].map((match, index) => [`${file} #${index + 1}`, match[1]!] as const)))).flat()

// Examples that also render with no props: a fragment of a larger file, or one needing a prop, is offered by the playground but shows its error there.
function renders(source: string): boolean {
  try {
    renderServer(stripTypes(compileKay(source, '/playground.kay', { root: '/', output: 'html' }).tsx))

    return true
  }
  catch {
    return false
  }
}

const runnable = examples.filter(([, source]) => runs(source) && renders(source))

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
    expect(renders('---\nconst a = props.nothing.deep\n---\np {a}\n')).toBe(false)
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

  it('mounts a component writing a link, whose browser code imports kay/i18n-links', async () => {
    const { dom } = browserCompile('---\nimport { signal } from \'kay\'\n\nconst to = signal(\'/about\')\n---\na(href={to()}) About\n')

    GlobalRegistrator.register()

    try {
      const unmount = mount(dom!, document.body)

      expect(document.body.querySelector('a')!.getAttribute('href')).toBe('/about')
      unmount()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('holds a source in a link\'s fragment and reads it back', () => {
    const source = '---\nconst a = \'é€\'\n---\np {a}\n'

    expect(sourceOfHash(playgroundHref(source).slice(playgroundHref(source).indexOf('#')))).toBe(source)
    expect(sourceOfHash('#other')).toBeUndefined()
  })
})

describe('the playground\'s sample', () => {
  it('type-checks as a page of an app', async () => {
    const root = await fixtureCopy('app')

    try {
      await Bun.write(join(root, 'src/routes/sample.kay'), SAMPLE)
      expect((await check(root)).filter(diagnostic => diagnostic.file?.endsWith('sample.kay')).map(diagnostic => diagnostic.message)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})

// Each step is a tick of the page's beat at that time, or `heard` at it for a reply from the frame.
function judged(steps: (number | ['heard', number])[]): string[] {
  const watched = watchdog()
  const verdicts: string[] = []

  for (const step of steps) {
    if (typeof step === 'number')
      verdicts.push(`${step} ${watched.tick(step)}`)
    else
      watched.heard()
  }

  return verdicts
}

describe('the playground\'s watchdog', () => {
  it('keeps a frame that answers when the page was busy past the limit with no ping out, though the interval\'s next tick follows its late one at once', () => {
    expect(judged([0, ['heard', 2], 1000, ['heard', 1002], 4990, 4996, ['heard', 5100], 6000])).toEqual(['0 ping', '1000 ping', '4990 ping', '4996 ping', '6000 ping'])
  })

  it('keeps a frame whose reply to a ping sent before the page went busy is handled after the late tick', () => {
    expect(judged([0, 3600, 3605, ['heard', 3610], 4000, ['heard', 4001], 5000])).toEqual(['0 ping', '3600 ping', '3605 ping', '4000 ping', '5000 ping'])
  })

  it('keeps a frame that answers once found overdue, before the next tick on the beat', () => {
    expect(judged([0, ['heard', 1], 1000, 2000, 3000, 4000, 5000, ['heard', 5200], 6000])).toEqual(['0 ping', '1000 ping', '2000 ping', '3000 ping', '4000 ping', '5000 ping', '6000 ping'])
  })

  it('finds a frame stuck once a ping went unanswered past the limit, on the next tick on the beat', () => {
    expect(judged([0, ['heard', 1], 1000, 2000, 3000, 4000, 5000, 5004, 6000])).toEqual(['0 ping', '1000 ping', '2000 ping', '3000 ping', '4000 ping', '5000 ping', '5004 ping', '6000 stuck'])
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

  it('never runs an example while highlighting it', async () => {
    await highlight('---\nglobalThis.__playgroundRan = true\n---\np hi\n', 'kay')

    expect((globalThis as { __playgroundRan?: boolean }).__playgroundRan).toBeUndefined()
  })
})

describe('the playground\'s bundles', () => {
  it('are built as the server starts listening, not when the first visitor asks', async () => {
    const build = spyOn(Bun, 'build').mockResolvedValue({ success: false, logs: [], outputs: [] })
    const app = (await playgroundWarm.server())

    try {
      expect(build).not.toHaveBeenCalled()

      app.listen(0)

      expect(build.mock.calls.map(([options]) => (options.entrypoints[0] ?? '').split('/').pop()).sort()).toEqual(['compile.ts', 'frame.ts'])
    }
    finally {
      await app.stop()
      build.mockRestore()
    }
  })
})
