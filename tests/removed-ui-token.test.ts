import type { CheckDiagnostic } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { removedUiTokens } from '../src/check/removed-ui-tokens'
import { UI_TOKEN_UTILITIES, UI_TOKENS } from '../src/check/ui-tokens'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ui-tokens-')

  await Promise.all(Object.entries({ 'tsconfig.json': '{}', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function fixed(files: Record<string, string>): Promise<{ root: string, found: CheckDiagnostic[], after: (path: string) => Promise<string> }> {
  const root = await project(files)
  const found = await removedUiTokens(root, {})

  await applySafeFixes(root, found)

  return { root, found, after: async path => Bun.file(join(root, path)).text() }
}

describe('removed-ui-token', () => {
  it('renames declarations the new name reads, references and utilities, in css', async () => {
    const css = [
      '@theme {',
      '  --color-kui-canvas: #fff;',
      '  --color-kui-accent: red;',
      '  --color-accent: blue;',
      '  --kui-density: 1.2;',
      '}',
      '.card {',
      '  color: var(--color-kui-muted, gray);',
      '  background: var(--color-kui-fill-danger);',
      '  padding: var(--spacing-kui-card);',
      '  border-width: var(--color-kui-text);',
      '  border-color: --theme(--color-kui-surface2);',
      '  @apply bg-kui-surface0 text-kui-text p-kui-card font-kui-heading rounded-kui-full;',
      '}',
      '/* --color-kui-text and bg-kui-canvas in a comment */',
      '',
    ].join('\n')
    const { root, after } = await fixed({ 'src/app.css': css })

    try {
      expect(await after('src/app.css')).toBe([
        '@theme {',
        '  --color-background: #fff;',
        '  --color-kui-accent: red;',
        '  --color-accent: blue;',
        '  --density: 1.2;',
        '}',
        '.card {',
        '  color: var(--color-muted, gray);',
        '  background: color-mix(in oklab, var(--color-danger) 10%, transparent);',
        '  padding: calc(var(--spacing) * 2.5 * var(--density));',
        '  border-width: var(--color-foreground);',
        '  border-color: --theme(--color-border);',
        '  @apply bg-surface text-foreground p-[calc(var(--spacing)*2.5*var(--density))] font-semibold rounded-full;',
        '}',
        '/* --color-kui-text and bg-kui-canvas in a comment */',
        '',
      ].join('\n'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a declaration of a folded or private name with the part to set, and fixes nothing', async () => {
    const css = ':root { --kui-border-badge: 2px; --color-kui-overlay1: gray; --kui-shell-line: red; --font-weight-kui-heading: 800; --radius-kui-card: 4px; --kui-badge-case: none; }\n'
    const { root, found, after } = await fixed({ 'src/app.css': css })

    try {
      expect(await after('src/app.css')).toBe(css)
      expect(found).toHaveLength(6)
      expect(found.every(problem => problem.code === 'removed-ui-token' && problem.severity === 'warning' && problem.fixes === undefined)).toBe(true)
      expect(found.find(problem => problem.message.startsWith('`--kui-badge-case`'))?.help).toContain('\'@kaynooo/kayjs-ui/badge.kay\': { parts: { root: \'normal-case\' } }')
      expect(found.find(problem => problem.message.startsWith('`--kui-shell-line`'))?.help).toContain('`--_shell-line`')
      expect(found.find(problem => problem.message.startsWith('`--kui-border-badge`'))?.message).toContain('`--border-width`')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rewrites utilities, arbitrary properties and styles of .kay files and src/ui.ts, keeping variants, signs and an opacity', async () => {
    const page = [
      'div(class="bg-kui-canvas hover:text-kui-accent-hi md:rounded-kui-card -mt-kui-section border-kui-surface2/50 [--kui-density:2] bg-(--color-kui-accent)" style="color: var(--color-kui-text); --kui-label-case: none") hi',
      'p(class="bg-kui-fill-danger/50 px-kui-badge-x font-kui-body text-kui-micro tracking-kui-section w-kui-field-height") x',
      'p(class="bg-card-kui-canvas not-bg-kui-canvasx") y',
      '',
    ].join('\n')
    const ui = 'export default { \'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'bg-kui-mantle border-kui-overlay0 text-kui-subtext0\' } } }\n'
    const { root, found, after } = await fixed({ 'src/routes/index.kay': page, 'src/ui.ts': ui })

    try {
      expect(await after('src/routes/index.kay')).toBe([
        'div(class="bg-background hover:text-accent-hover md:rounded-lg -mt-[calc(var(--spacing)*3.5*var(--density))] border-border/50 [--density:2] bg-(--color-accent)" style="color: var(--color-foreground); --label-case: none") hi',
        'p(class="bg-kui-fill-danger/50 px-1.5 font-[family-name:inherit] text-2xs tracking-label w-[calc(2*var(--border-width)_+_2*var(--spacing)*var(--density)_+_var(--text-sm)*var(--text-sm--line-height))]") x',
        'p(class="bg-card-kui-canvas not-bg-kui-canvasx") y',
        '',
      ].join('\n'))
      expect(await after('src/ui.ts')).toBe('export default { \'@kaynooo/kayjs-ui/card.kay\': { parts: { root: \'bg-popover border-border-strong text-muted\' } } }\n')
      expect(found.filter(problem => problem.fixes === undefined).map(problem => (/^`[^`]+`/).exec(problem.message)?.[0])).toEqual(['`bg-kui-fill-danger`'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a declaration whose block sets the new name, or whose new name another old one takes, and applies the rest on a second run', async () => {
    const css = ':root { --color-kui-accent: red; --color-accent: blue; }\n:root { --color-kui-muted: gray; --color-kui-subtext0: black; --kui-chart-1: red; }\n.a { --color-kui-accent: green; --color-kui-accent-hi: lime; }\n'
    const { root, after } = await fixed({ 'src/app.css': css })

    try {
      expect(await after('src/app.css')).toBe(':root { --color-kui-accent: red; --color-accent: blue; }\n:root { --color-muted: gray; --color-kui-subtext0: black; --kui-chart-1: red; }\n.a { --color-accent: green; --color-accent-hover: lime; }\n')
      expect(await removedUiTokens(root, {})).toHaveLength(3)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours kay-allow, the lint level and files that are not the project\'s', async () => {
    const page = '// kay-allow removed-ui-token\np(class="bg-kui-canvas") a\np(class="bg-kui-canvas") b\n'
    const root = await project({ 'src/routes/index.kay': page, 'node_modules/lib/a.css': '.a { color: var(--color-kui-text); }' })

    try {
      expect((await removedUiTokens(root, {})).map(problem => problem.line)).toEqual([3])
      expect(await removedUiTokens(root, { lints: { 'removed-ui-token': 'allow' } })).toEqual([])
      expect((await removedUiTokens(root, { lints: { 'removed-ui-token': 'deny' } }))[0]?.severity).toBe('error')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rewrites the utilities of names that kept their namespace, and nested fallbacks over two runs', async () => {
    const css = '.a { @apply rounded-kui-sm rounded-t-kui-md tracking-kui-label text-kui-2xs font-kui-mono; color: var(--color-kui-text, var(--color-kui-muted)); }\n'
    const { root, after } = await fixed({ 'src/app.css': css })

    try {
      expect(await after('src/app.css')).toBe('.a { @apply rounded-sm rounded-t-md tracking-label text-2xs font-mono; color: var(--color-foreground, var(--color-muted)); }\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports what reads a name the app declares and keeps, instead of dropping its value', async () => {
    const css = '@theme { --spacing-kui-card: 1rem; --color-kui-accent: red; --color-accent: blue; }\n.a { padding: var(--spacing-kui-card); color: var(--color-kui-accent); @apply p-kui-card bg-kui-accent; }\n'
    const page = 'p(class="[--color-kui-accent:red]\n [--color-accent:blue] text-kui-accent") hi\n'
    const { root, after } = await fixed({ 'src/app.css': css, 'src/routes/index.kay': page })

    try {
      expect(await after('src/app.css')).toBe(css)
      expect(await after('src/routes/index.kay')).toBe(page)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a utility still written with a removed name, in .kay classes and @apply, naming its replacement', async () => {
    const { root, found, after } = await fixed({ 'src/routes/index.kay': 'div(class="border border-kui-border bg-kui-surface bg-kui-surface0") hi\n', 'src/app.css': '.a { @apply border-kui-border; }\n' })

    try {
      expect(found.map(problem => (/^`[^`]+`/).exec(problem.message)?.[0]).sort()).toEqual(['`bg-kui-surface0`', '`bg-kui-surface`', '`border-kui-border`', '`border-kui-border`'])
      expect(found.every(problem => problem.code === 'removed-ui-token')).toBe(true)
      expect(found.find(problem => problem.message.startsWith('`bg-kui-surface0`'))?.message).toContain('`bg-surface`')
      expect(found.find(problem => problem.message.startsWith('`bg-kui-surface`'))?.help).toContain('1.75.0')
      expect(await after('src/routes/index.kay')).toBe('div(class="border border-kui-border bg-kui-surface bg-surface") hi\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('has a utility pattern for every name a utility can read', () => {
    const names = UI_TOKEN_UTILITIES.flatMap(({ tokens }) => [...tokens.keys()])

    expect(Object.entries(UI_TOKENS).filter(([, token]) => token.kind !== 'var' && token.utility === undefined && token.help === undefined).map(([name]) => name)).toEqual([])
    expect(names).toContain('canvas')
    expect(names).toContain('card')
    expect(names).toContain('heading')
    expect(Object.keys(UI_TOKENS).filter(name => name.includes('kui-') && !name.startsWith('--kui-') && !name.includes('--line-height')).length).toBe(names.length)
  })
})
