import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

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

const unknown = (source: string) => run(source, 'unknown-link-flag')

describe('unknown-link-flag', () => {
  it.each([['server', SERVER], ['island', ISLAND]])('refuses a misspelt navigation flag in a %s template, naming the one meant', (_, head) => {
    const result = unknown(`${head}a(href="/x" data-scrol="keep") go\na(href="/x" data-prefech="eager") go\na(href="/x" data-transtion="false") go\na(href="/x" data-relaod) go\n`)

    expect(result.at).toEqual(['data-scrol', 'data-prefech', 'data-transtion', 'data-relaod'])
    expect(result.severity).toEqual(['error', 'error', 'error', 'error'])
    expect(result.help.map(help => (/`(data-[^`]+)`/).exec(help ?? '')?.[1])).toEqual(['data-scroll', 'data-prefetch', 'data-transition', 'data-reload'])
  })

  it('finds a misspelt flag on a component call and with a dynamic value', () => {
    expect(unknown(`${ISLAND}Button(href={to} data-scrol)\na(href={to} data-prefetc={open() ? 'eager' : undefined}) go\n`).at).toEqual(['data-scrol', 'data-prefetc'])
  })

  it('takes the names of the family and the data attributes of kay and of an app', () => {
    expect(unknown(`${SERVER}a(href="/x" data-scroll="keep" data-transition="false" data-reload data-prefetch="eager" data-part="a" data-field data-pending data-tooltip="x" data-hint="y" data-provider="p" data-testid="t" data-kay-retry) go\n`).at).toEqual([])
  })

  it('reports the names before 1.105, which nothing reads, with the flag to write', () => {
    const found = unknown(`${SERVER}a(href="/x" data-keep-scroll) go\na(href="/y" data-no-transition) go\na(href="/z" data-no-prefetch) go\n`)

    expect(found.at).toEqual(['data-keep-scroll', 'data-no-transition', 'data-no-prefetch'])
    expect(found.help).toEqual(['write `data-scroll="keep"`', 'write `data-transition="false"`', 'write `data-prefetch="false"`'])
  })

  it('leaves a name that goes on after a flag, or a word near one, to the app', () => {
    expect(unknown(`${SERVER}a(href="/x" data-scrolled data-scroll-x data-reloading data-prefetched data-translation data-transitions data-read data-presence data-keep-scroll-x) go\n`).at).toEqual([])
  })
})
