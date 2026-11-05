import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

function lints(source: string, options: Record<string, 'allow' | 'warn'> = {}) {
  return compileKay(source, join(process.cwd(), 'widget.kay'), { check: true, lints: options }).diagnostics.filter(diagnostic => diagnostic.code === 'unowned-effect').map(diagnostic => [diagnostic.code, source.slice(diagnostic.start, diagnostic.end)])
}

const page = (script: string, template = 'button(onClick={() => count = 1}) {count()}') => `---\nimport { effect, every, listen, onCleanup, onMount, root, signal, watch } from 'kay'\n\nconst count = signal(0)\n${script}\n---\n${template}\n`

describe('unowned-effect', () => {
  it('flags an effect, watch, every, listen, onMount or onCleanup made in an event handler', () => {
    for (const call of ['effect(() => count())', 'watch(count, () => {})', 'every(\'1s\', () => {})', 'listen(window, \'resize\', () => {})', 'onMount(() => {})', 'onCleanup(() => {})'])
      expect(lints(page('', `button(onClick={() => ${call}}) go`)), call).toEqual([['unowned-effect', call.slice(0, call.indexOf('('))]])

    expect(lints(page('', 'button(onClick={() => { count = 1; effect(() => count()) }}) go'))).toEqual([['unowned-effect', 'effect']])
  })

  it('flags one made in a timer, a promise callback, a listen handler or after an await', () => {
    expect(lints(page('setTimeout(() => effect(() => count()), 10)'))).toEqual([['unowned-effect', 'effect']])
    expect(lints(page('Promise.resolve().then(() => onCleanup(() => {}))'))).toEqual([['unowned-effect', 'onCleanup']])
    expect(lints(page('listen(window, \'keydown\', () => effect(() => count()))'))).toEqual([['unowned-effect', 'effect']])
    expect(lints(page('async function load() {\n  await fetch(\'/x\')\n  effect(() => count())\n}'))).toEqual([['unowned-effect', 'effect']])
    expect(lints(page('effect(async () => {\n  await Promise.resolve()\n  onCleanup(() => {})\n})'))).toEqual([['unowned-effect', 'onCleanup']])
  })

  it('leaves alone the component script, an effect inside an effect, and a call before the await', () => {
    expect(lints(page('effect(() => count())\nwatch(count, () => {})\nonMount(() => {})\nonCleanup(() => {})'))).toEqual([])
    expect(lints(page('effect(() => {\n  effect(() => count())\n  onCleanup(() => {})\n})'))).toEqual([])
    expect(lints(page('async function load() {\n  effect(() => count())\n  await fetch(\'/x\')\n}'))).toEqual([])
  })

  it('leaves alone a call under root, in a handler or after an await, which hands over a dispose', () => {
    expect(lints(page('', 'button(onClick={() => root(() => effect(() => count()))}) go'))).toEqual([])
    expect(lints(page('async function load() {\n  await fetch(\'/x\')\n  root(() => effect(() => count()))\n}'))).toEqual([])
  })

  it('leaves alone an await in another branch, and a name that is not kay\'s', () => {
    expect(lints(page('async function load(ok: boolean) {\n  if (ok) {\n    await fetch(\'/x\')\n  }\n  else {\n    effect(() => count())\n  }\n}'))).toEqual([])
    expect(lints('---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst effect = (fn: () => void) => fn()\n---\nbutton(onClick={() => effect(() => count())}) go\n')).toEqual([])
  })

  it('is a lint a kay-allow comment and the lint level reach', () => {
    const handler = page('', 'button(onClick={() => effect(() => count())}) go')

    expect(lints(handler)).toHaveLength(1)
    expect(lints(page('// kay-allow unowned-effect\nsetTimeout(() => effect(() => count()), 10)'))).toEqual([])
    expect(lints(handler, { 'unowned-effect': 'allow' })).toEqual([])
  })
})
