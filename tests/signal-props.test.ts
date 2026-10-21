import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { deprecatedSignalProps } from '../src/check/signal-props'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('signal-props-')

  await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, ...files }).map(async ([path, content]) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), content)
  }))

  return root
}

// Reports the deprecated props, applies their fixes, and answers the reports and the files as they are then.
async function migrate(files: Record<string, string>) {
  const root = await project(files)

  try {
    const reports = await deprecatedSignalProps(root, {})
    const fixed = await applySafeFixes(root, reports)
    const texts = new Map(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()] as const)))

    return { reports, fixed, text: async (path: string) => texts.get(path)!, after: await deprecatedSignalProps(root, {}) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const TOGGLE = '---\nimport type { Signal } from \'kay\'\n\nconst { open } = props<{ open: Signal<boolean> }>()\n---\nbutton(onClick={() => open = !open()}) {open() ? \'on\' : \'off\'}\n'
const PAGE = '---\nimport { signal } from \'kay\'\nimport Toggle from \'../components/Toggle.kay\'\n\nconst open = signal(false)\n---\nToggle(open={open})\n'

describe('deprecated-signal-prop', () => {
  it('rewrites a Signal prop, its reads and the tag passing it, an island child as a page', async () => {
    const files = { 'src/components/Toggle.kay': TOGGLE, 'src/routes/index.kay': PAGE }
    const root = await project(files)

    try {
      const reports = await deprecatedSignalProps(root, {})

      expect(reports.map(report => [report.code, report.severity, report.file.slice(root.length + 1)])).toEqual([
        ['deprecated-signal-prop', 'warning', 'src/components/Toggle.kay'],
        ['deprecated-signal-prop', 'warning', 'src/routes/index.kay'],
      ])
      expect(reports.every(report => report.fixes?.[0]?.safe === true || report.file.endsWith('Toggle.kay'))).toBe(true)
      expect(await applySafeFixes(root, reports)).toBe(2)
      expect(await Bun.file(join(root, 'src/components/Toggle.kay')).text()).toBe('---\nimport type { Bindable } from \'kay\'\n\nconst { open } = props<{ open: Bindable<boolean> }>()\n---\nbutton(onClick={() => open = !open}) {open ? \'on\' : \'off\'}\n')
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe(PAGE.replace('Toggle(open={open})', 'Toggle(bind:open={open})'))
      expect(await deprecatedSignalProps(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds the type in a script interface and a type alias, and a shorthand tag', async () => {
    const interfaced = '---\nimport { type Signal } from \'kay\'\n\ninterface Props {\n  open: Signal<boolean>\n  label: string\n}\n\nconst { open, label } = props<Props>()\n---\nbutton(onClick={() => open = !open()}) {label}\n'
    const aliased = '---\nimport type { Signal } from \'kay\'\n\ntype Props = { count: Signal<number> }\n\nconst { count } = props<Props>()\n---\nbutton(onClick={() => count++}) {count()}\n'
    const result = await migrate({
      'src/components/A.kay': interfaced,
      'src/components/B.kay': aliased,
      'src/routes/index.kay': '---\nimport { signal } from \'kay\'\nimport A from \'../components/A.kay\'\nimport B from \'../components/B.kay\'\n\nconst open = signal(false)\nconst count = signal(0)\n---\nA(label="a" {open})\nB({count})\n',
    })

    expect(result.fixed).toBe(4)
    expect(await result.text('src/components/A.kay')).toContain('  open: Bindable<boolean>\n')
    expect(await result.text('src/components/A.kay')).toContain('import { type Bindable } from \'kay\'')
    expect(await result.text('src/components/A.kay')).toContain('open = !open}')
    expect(await result.text('src/components/B.kay')).toContain('type Props = { count: Bindable<number> }')
    expect(await result.text('src/components/B.kay')).toContain('{count}')
    expect(await result.text('src/routes/index.kay')).toContain('A(label="a" bind:open={open})\nB(bind:count={count})')
    expect(result.after).toEqual([])
  })

  it('types a Memo prop as its value, read plainly, passed called', async () => {
    const result = await migrate({
      'src/components/Total.kay': '---\nimport type { Memo } from \'kay\'\n\nconst { total } = props<{ total: Memo<number> }>()\n---\np {total() * 2}\n',
      'src/routes/index.kay': '---\nimport { signal, memo } from \'kay\'\nimport Total from \'../components/Total.kay\'\n\nconst n = signal(1)\nconst doubled = memo(() => n() * 2)\n---\nTotal(total={doubled})\n',
    })

    expect(result.fixed).toBe(2)
    expect(await result.text('src/components/Total.kay')).toBe('---\n\nconst { total } = props<{ total: number }>()\n---\np {total * 2}\n')
    expect(await result.text('src/routes/index.kay')).toContain('Total(total={doubled()})')
  })

  it('keeps a Signal import another use needs, and mixes Signal and Memo in one import', async () => {
    const result = await migrate({
      'src/components/Mixed.kay': '---\nimport { signal, type Signal, type Memo } from \'kay\'\n\nconst { open, size } = props<{ open: Signal<boolean>, size: Memo<number> }>()\nconst local: Signal<number> = signal(size())\n---\nbutton(onClick={() => open = !open()}) {local()}\n',
      'src/routes/index.kay': '---\nimport { signal, memo } from \'kay\'\nimport Mixed from \'../components/Mixed.kay\'\n\nconst open = signal(false)\nconst size = memo(() => 2)\n---\nMixed(open={open} size={size})\n',
    })

    expect(await result.text('src/components/Mixed.kay')).toBe('---\nimport { signal, type Signal, type Bindable } from \'kay\'\n\nconst { open, size } = props<{ open: Bindable<boolean>, size: number }>()\nconst local: Signal<number> = signal(size)\n---\nbutton(onClick={() => open = !open}) {local()}\n')
    expect(await result.text('src/routes/index.kay')).toContain('Mixed(bind:open={open} size={size()})')
  })

  it('hands a prop on to another migrated component, and a Memo prop on as the value it is', async () => {
    const result = await migrate({
      'src/components/Toggle.kay': TOGGLE,
      'src/components/Panel.kay': '---\nimport type { Memo, Signal } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nimport Total from \'./Total.kay\'\n\nconst { open, total } = props<{ open: Signal<boolean>, total: Memo<number> }>()\n---\nToggle(open={open})\nTotal(total={total})\n',
      'src/components/Total.kay': '---\nimport type { Memo } from \'kay\'\n\nconst { total } = props<{ total: Memo<number> }>()\n---\np {total()}\n',
      'src/routes/index.kay': '---\nimport { signal, memo } from \'kay\'\nimport Panel from \'../components/Panel.kay\'\n\nconst open = signal(false)\nconst total = memo(() => 1)\n---\nPanel(open={open} total={total})\n',
    })

    expect(await result.text('src/components/Panel.kay')).toBe('---\nimport type { Bindable } from \'kay\'\nimport Toggle from \'./Toggle.kay\'\nimport Total from \'./Total.kay\'\n\nconst { open, total } = props<{ open: Bindable<boolean>, total: number }>()\n---\nToggle(bind:open={open})\nTotal(total={total})\n')
    expect(await result.text('src/routes/index.kay')).toContain('Panel(bind:open={open} total={total()})')
    expect(result.after).toEqual([])
  })

  it('offers no fix, and says why, when a tag spreads props or passes an expression, and rewrites nothing for that prop', async () => {
    const page = '---\nimport { signal, memo } from \'kay\'\nimport Toggle from \'../components/Toggle.kay\'\nimport Total from \'../components/Total.kay\'\n\nconst open = signal(false)\nconst rest = { open }\nconst n = signal(1)\n---\nToggle({...rest})\nTotal(total={n() * 2})\n'
    const total = '---\nimport type { Memo } from \'kay\'\n\nconst { total } = props<{ total: Memo<number> }>()\n---\np {total()}\n'
    const result = await migrate({ 'src/components/Toggle.kay': TOGGLE, 'src/components/Total.kay': total, 'src/routes/index.kay': page })

    expect(result.fixed).toBe(0)
    expect(result.reports.every(report => report.fixes === undefined)).toBe(true)
    expect(result.reports.map(report => report.note).filter(Boolean).join('\n')).toContain('spreads props into `Toggle`')
    expect(result.reports.map(report => report.note).filter(Boolean).join('\n')).toContain('no name or property path')
    expect(await result.text('src/components/Toggle.kay')).toBe(TOGGLE)
    expect(await result.text('src/components/Total.kay')).toBe(total)
    expect(await result.text('src/routes/index.kay')).toBe(page)
  })

  it('leaves a prop the component uses other than by calling it, and its tags', async () => {
    const child = '---\nimport type { Signal } from \'kay\'\n\nconst { open } = props<{ open: Signal<boolean> }>()\n---\nbutton(onClick={() => open.set(true)}) {open()}\n'
    const result = await migrate({ 'src/components/Toggle.kay': child, 'src/routes/index.kay': PAGE })

    expect(result.fixed).toBe(0)
    expect(result.reports.map(report => [report.file.endsWith('Toggle.kay'), report.fixes === undefined, report.note])).toEqual([[true, true, 'not fixed: it is used other than by calling it or handing it to a component']])
    expect(await result.text('src/routes/index.kay')).toBe(PAGE)
  })

  it('leaves a prop of a component reading its props through the object, and an optional one', async () => {
    const named = '---\nimport type { Signal } from \'kay\'\n\nconst p = props<{ open: Signal<boolean>, extra?: Signal<number> }>()\n---\nbutton(onClick={() => p.open.set(true)}) {p.open()}\n'
    const result = await migrate({ 'src/components/Toggle.kay': named, 'src/routes/index.kay': PAGE })

    expect(result.fixed).toBe(0)
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]!.note).toContain('not destructured')
  })

  it('leaves a library component under node_modules and the tags passing it alone', async () => {
    const result = await migrate({
      'node_modules/lib/Toggle.kay': TOGGLE,
      'node_modules/lib/package.json': '{ "name": "lib", "version": "1.0.0" }',
      'src/routes/index.kay': '---\nimport { signal } from \'kay\'\nimport Toggle from \'lib/Toggle.kay\'\n\nconst open = signal(false)\n---\nToggle(open={open})\n',
    })

    expect(result.reports).toEqual([])
    expect(await result.text('node_modules/lib/Toggle.kay')).toBe(TOGGLE)
  })

  it('is silent when the lint is allowed', async () => {
    const root = await project({ 'src/components/Toggle.kay': TOGGLE, 'src/routes/index.kay': PAGE })

    try {
      expect(await deprecatedSignalProps(root, { lints: { 'deprecated-signal-prop': 'allow' } })).toEqual([])
      expect((await deprecatedSignalProps(root, { lints: { deprecated: 'deny' } })).every(report => report.severity === 'error')).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs with `kay check --fix --since 1.70` and leaves a project that type-checks', async () => {
    const root = await project({
      'src/components/Toggle.kay': TOGGLE,
      'src/components/Total.kay': '---\nimport type { Memo } from \'kay\'\n\nconst { total } = props<{ total: Memo<number> }>()\n---\np {total()}\n',
      'src/routes/_layout.kay': '---\nimport { signal, memo } from \'kay\'\nimport Toggle from \'../components/Toggle.kay\'\nimport Total from \'../components/Total.kay\'\n\nconst open = signal(false)\nconst n = signal(1)\nconst doubled = memo(() => n() * 2)\n---\nToggle(open={open})\nTotal(total={doubled})\nslot\n',
      'src/routes/index.kay': 'h1 Home\n',
    })

    try {
      const before = await kayCheck([root])

      expect(before.output).toContain('deprecated-signal-prop')

      const fix = await kayCheck([root, '--fix', '--since', '1.70'])

      expect(fix.output).not.toContain('deprecated-signal-prop')

      const after = await kayCheck([root])

      expect(after.output).not.toContain('error')
      expect(after.code).toBe(0)
      expect(await Bun.file(join(root, 'src/routes/_layout.kay')).text()).toContain('Toggle(bind:open={open})\nTotal(total={doubled()})')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
