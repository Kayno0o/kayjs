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
