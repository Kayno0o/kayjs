import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('module-fence-')
const MARKERS = /<!--[[\]]-->/g
const files: Record<string, string> = {
  'counter.kay': '--- module\nimport { signal } from \'kay\'\n\nexport const visits = signal(0)\nexport function label(count: number): string {\n  return `${count} visits`\n}\nlet renders = 0\n--- script\nconst { name } = props<{ name: string }>()\nrenders++\n---\np {name}: {label(renders)}\n',
  'reader.kay': '---\nimport { label } from \'./counter.kay\'\n---\nspan {label(2)}\n',
}

beforeAll(async () => {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(scratch, name), text)))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('the module fence', () => {
  it('keeps its code at module level, so state outlives a render and an importer reads its exports', async () => {
    const counter = await import(join(scratch, 'counter.kay')) as { default: (props: Record<string, unknown>) => unknown, label: (count: number) => string }
    const first = child(counter.default({ name: 'a' })).replace(MARKERS, '')
    const second = child(counter.default({ name: 'b' })).replace(MARKERS, '')

    expect(first).toContain('a: 1 visits')
    expect(second).toContain('b: 2 visits')
    expect(counter.label(5)).toBe('5 visits')

    const reader = await import(join(scratch, 'reader.kay')) as { default: () => unknown }

    expect(child(reader.default()).replace(MARKERS, '')).toContain('2 visits')
  })

  it('makes a component an island when the fence uses a value from kay, and not otherwise', () => {
    expect(compileKay('--- module\nexport const unit = 1\n---\np {unit}\n', 'part.kay').island).toBeUndefined()
    expect(compileKay('--- module\nimport { signal } from \'kay\'\n\nexport const open = signal(false)\n---\nbutton(onClick={() => open.set(true)}) go\n', 'part.kay').island).toBeDefined()
  })

  it('writes the fence into the browser output too, before the component', () => {
    const code = compileKay(files['counter.kay']!, 'counter.kay', { output: 'dom', root: scratch }).tsx

    expect(code.indexOf('export const visits')).toBeGreaterThan(-1)
    expect(code.indexOf('export const visits')).toBeLessThan(code.indexOf('function '))
  })

  it('refuses props, a default export, a second fence and a client component in it', () => {
    const messages = (source: string) => compileKay(source, 'part.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.message)

    expect(messages('--- module\nconst { a } = props<{ a: string }>()\n---\np x\n')).toEqual([expect.stringContaining('declares no props')])
    expect(messages('--- module\nexport default 1\n---\np x\n')).toEqual([expect.stringContaining('default export')])
    expect(messages('--- module\nexport const a = 1\n---\n--- module\nexport const b = 2\n---\np x\n')).toEqual([expect.stringContaining('one `--- module` fence')])
    expect(messages('--- client\nlet a = 1\n---\n--- module\nexport const b = 2\n---\np {a}\n')).toEqual([expect.stringContaining('no `--- module` fence')])
  })
})

describe('kay check on a module fence', () => {
  it('types the exports for the importers', async () => {
    const root = await scratchDir('module-fence-check-')

    try {
      await Promise.all(Object.entries({
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
        'src/counter.kay': files['counter.kay']!,
        'src/routes/index.kay': '---\nimport { label, visits } from \'../counter.kay\'\nconst text: number = label(visits())\n---\np {text}\n',
      }).map(async ([path, content]) => Bun.write(join(root, path), content)))

      const messages = (await check(root)).map(diagnostic => diagnostic.message)

      expect(messages).toEqual([expect.stringContaining('not assignable to type \'number\'')])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('what reads the fences of a file', () => {
  it('follows a module fence\'s imports and data, and judges its state', async () => {
    const { fences } = await import('../src/build/libraries')

    expect(fences('--- module\nimport \'./a.css\'\nexport const kinds = { primary: \'btn-primary\' }\n--- script\nconst x = 1\n---\np\n')).toContain('btn-primary')
  })
})

describe('what the analyses read of a module fence', () => {
  const found = (source: string, options: Parameters<typeof compileKay>[2] = {}) => compileKay(source, 'part.kay', { check: true, ...options }).diagnostics.map(diagnostic => diagnostic.code)

  it('lints its imports, stylesheets, markup props and browser reads as the script\'s own', () => {
    const island = '--- module\nimport { signal } from \'kay\'\nimport { sqliteCache } from \'kay/cache\'\nimport theme from \'./theme.css\'\n\nexport const open = signal(false)\nconsole.log(sqliteCache, theme)\n---\nbutton(onClick={() => open.set(true)}) go\n'

    expect(found(island)).toEqual(expect.arrayContaining(['server-only-import', 'css-import-without-text']))
    expect(found('--- module\nexport const width = window.innerWidth\n---\np {width}\n')).toContain('browser-only-read')
    expect(found('--- module\nexport const width = typeof window === \'undefined\' ? 0 : window.innerWidth\n---\np {width}\n')).not.toContain('browser-only-read')
  })

  it('knows a signal a module fence exports in its importers, so assigning it writes it', async () => {
    const root = await scratchDir('module-fence-signals-')

    try {
      await Promise.all(Object.entries({
        'counter.kay': files['counter.kay']!,
        'bump.kay': '---\nimport { visits } from \'./counter.kay\'\n---\nbutton(onClick={() => visits++}) {visits()}\n',
      }).map(async ([name, text]) => Bun.write(join(root, name), text)))

      const source = await Bun.file(join(root, 'bump.kay')).text()
      const { importedSignals } = await import('../src/build/signals')
      const signals = importedSignals(join(root, 'bump.kay'), source)

      expect(signals).toEqual({ './counter.kay': { visits: 'signal' } })
      expect(compileKay(source, join(root, 'bump.kay'), { importedSignals: signals, output: 'dom', root }).tsx).toContain('visits.set(')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the renamed options of a library call in a module fence', async () => {
    const { rateLimitNames } = await import('../src/check/rate-limit')
    const root = await scratchDir('module-fence-options-')

    try {
      await Bun.write(join(root, 'src/part.kay'), '--- module\nimport { ai } from \'@kaynooo/kayjs-ai\'\nexport const model = ai({ limit: 5 })\n---\np x\n')

      expect((await rateLimitNames(root, {})).map(diagnostic => diagnostic.message)).toEqual([expect.stringContaining('limit')])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not call an exported signal constant, as an importer may write it', () => {
    expect(found('--- module\nimport { signal } from \'kay\'\nexport const shown = signal(1)\nconst hidden = signal(2)\n---\np {shown()} {hidden()}\n')).toEqual(['constant-signal'])
  })

  it('moves the imports of a module fence with a renamed file', async () => {
    const { importEdits } = await import('../src/lsp/renames')
    const source = '--- module\nimport { x } from \'../lib/x.kay\'\nexport const y = x\n---\np {y}\n'

    expect(importEdits('/app/src/routes/part.kay', source, new Map([['/app/src/lib/x.kay', '/app/src/shared/x.kay']])).map(edit => edit.text)).toEqual(['../shared/x.kay'])
  })
})
