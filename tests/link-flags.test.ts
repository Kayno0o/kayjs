import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { LINTS } from '../src/compiler/lints'

const SERVER = '---\nconst { open, to } = props<{ open: boolean, to: string }>()\n---\n'
const ISLAND = '---\nimport { signal } from \'kay\'\nconst open = signal(false)\nconst to = \'/x\'\n---\n'

function run(source: string, code: string) {
  const found = compileKay(source, 'page.kay', { check: true }).diagnostics.filter(d => d.code === code)
  const edits = found.flatMap(d => d.fixes?.[0]?.edits ?? []).sort((a, b) => b.start - a.start)

  return {
    at: found.map(d => source.slice(d.start, d.end)),
    severity: found.map(d => d.severity),
    safe: found.map(d => d.fixes?.[0]?.safe),
    help: found.map(d => d.help),
    fixed: edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source),
  }
}

const deprecated = (source: string) => run(source, 'deprecated-link-flags')
const unknown = (source: string) => run(source, 'unknown-link-flag')

describe('deprecated-link-flags', () => {
  it.each([['server', SERVER], ['island', ISLAND]])('writes the options of navigate on a link of a %s template', (_, head) => {
    const result = deprecated(`${head}a(href="/x" data-keep-scroll) go\na(href="/x" data-no-transition) go\na(href="/x" data-no-prefetch) go\na(href="/x" data-keep-scroll="false") go\na(href="/x" data-keep-scroll="") go\n`)

    expect(result.at).toEqual(['data-keep-scroll', 'data-no-transition', 'data-no-prefetch', 'data-keep-scroll', 'data-keep-scroll'])
    expect(result.safe).toEqual([true, true, true, true, true])
    expect(result.fixed).toBe(`${head}a(href="/x" data-scroll="keep") go\na(href="/x" data-transition="false") go\na(href="/x" data-prefetch="false") go\na(href="/x" data-scroll="top") go\na(href="/x" data-scroll="keep") go\n`)
  })

  it('renames a dynamic value, which the runtime reads as it read the old one, and leaves a negated flag with no fix', () => {
    const result = deprecated(`${ISLAND}a(href={to} data-keep-scroll={open() ? '' : undefined}) go\na(href={to} data-no-transition={open()}) go\n`)

    expect(result.at).toEqual(['data-keep-scroll', 'data-no-transition'])
    expect(result.safe).toEqual([true, undefined])
    expect(result.fixed).toBe(`${ISLAND}a(href={to} data-scroll={open() ? '' : undefined}) go\na(href={to} data-no-transition={open()}) go\n`)
  })

  it('finds the flag on a container and on a component a link is forwarded through', () => {
    const result = deprecated(`${SERVER}nav(data-keep-scroll)\n  a(href="/x") go\nButton(href={to} label="Go" data-no-prefetch)\nform(data-no-transition)\n  button go\n`)

    expect(result.at).toEqual(['data-keep-scroll', 'data-no-prefetch', 'data-no-transition'])
    expect(result.fixed).toBe(`${SERVER}nav(data-scroll="keep")\n  a(href="/x") go\nButton(href={to} label="Go" data-prefetch="false")\nform(data-transition="false")\n  button go\n`)
  })

  it('leaves the new names, data-reload and another attribute alone', () => {
    expect(deprecated(`${SERVER}a(href="/x" data-scroll="keep" data-transition="false" data-prefetch="eager" data-reload) go\na(href="/x" data-keep-scroll-x data-nope) go\n`).at).toEqual([])
  })

  it('is a warning of the deprecated group, since 1.105', () => {
    expect(LINTS['deprecated-link-flags']).toMatchObject({ level: 'warn', group: 'deprecated', since: '1.105' })
    expect(deprecated(`${SERVER}a(href="/x" data-no-prefetch) go\n`).severity).toEqual(['warning'])
  })
})

describe('unknown-link-flag', () => {
  it.each([['server', SERVER], ['island', ISLAND]])('refuses a misspelt navigation flag in a %s template, naming the one meant', (_, head) => {
    const result = unknown(`${head}a(href="/x" data-scrol="keep") go\na(href="/x" data-prefech="eager") go\na(href="/x" data-no-scroll) go\na(href="/x" data-transitions="false") go\na(href="/x" data-realod) go\n`)

    expect(result.at).toEqual(['data-scrol', 'data-prefech', 'data-no-scroll', 'data-transitions', 'data-realod'])
    expect(result.severity).toEqual(['error', 'error', 'error', 'error', 'error'])
    expect(result.help.map(help => (/`(data-[a-z-]+)`/).exec(help ?? '')?.[1])).toEqual(['data-scroll', 'data-prefetch', 'data-scroll', 'data-transition', 'data-reload'])
  })

  it('finds a misspelt flag on a component call and with a dynamic value', () => {
    expect(unknown(`${ISLAND}Button(href={to} data-keep-scrol)\na(href={to} data-prefetchh={open() ? 'eager' : undefined}) go\n`).at).toEqual(['data-keep-scrol', 'data-prefetchh'])
  })

  it('takes the names of the family, the old ones included, and the data attributes of kay and of an app', () => {
    expect(unknown(`${SERVER}a(href="/x" data-scroll="keep" data-transition="false" data-reload data-prefetch="eager" data-keep-scroll data-no-transition data-no-prefetch data-part="a" data-field data-pending data-tooltip="x" data-hint="y" data-provider="p" data-testid="t" data-kay-retry) go\n`).at).toEqual([])
  })
})
