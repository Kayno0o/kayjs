import * as parser from '@babel/parser'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { selection, signal } from '../src/runtime/core'
import { updateBack, updateTo, writeBack, writeTo } from '../src/runtime/internal'
import { isSignal, memo } from '../src/runtime/reactive'

type Output = 'dom' | 'html' | undefined

function compiled(source: string, output: Output, check = false) {
  const result = compileKay(source, 'test.kay', check ? { check: true } : { output })

  expect(result.diagnostics.map(d => d.message)).toEqual([])
  expect(() => parser.parse(result.tsx, { sourceType: 'module', plugins: ['typescript', 'jsx'] })).not.toThrow()

  return result.tsx
}

const SCRIPT = '---\nimport { makeBox } from \'./box\'\nconst box = makeBox()\nlet picked = makeBox().count\nfunction f() {\n  box.count = 1\n  box.list[2] = 3\n  box.count += 2\n  box.count++\n  --box.list[0]\n  picked = 4\n  picked *= 2\n  picked++\n}\n---\nbutton(onClick={() => box.count++}) go\n'

describe('assignments the runtime tells from a write', () => {
  it('write a property, an element and a let through helpers in an island, on the server and when type checking', () => {
    for (const code of [compiled(SCRIPT, 'dom'), compiled(SCRIPT, 'html'), compiled(SCRIPT, undefined, true)]) {
      expect(code).toContain('KayWriteTo(box, "count", 1)')
      expect(code).toContain('KayWriteTo(box.list, 2, 3)')
      expect(code).toContain('KayUpdateTo(box, "count", (KayCurrent) => KayCurrent + (2))')
      expect(code).toContain('KayUpdateTo(box, "count", (KayCurrent) => ++KayCurrent, "post")')
      expect(code).toContain('KayUpdateTo(box.list, 0, (KayCurrent) => --KayCurrent)')
      expect(code).toContain('picked = KayWriteBack(picked, 4)')
      expect(code).toContain('picked = KayUpdateBack(picked, (KayCurrent) => KayCurrent * (2))')
      expect(code).toContain('picked = KayUpdateBack(picked, (KayCurrent) => ++KayCurrent)')
      expect(code).toMatch(/import \{ writeTo as KayWriteTo, updateTo as KayUpdateTo, writeBack as KayWriteBack, updateBack as KayUpdateBack \} from 'kay\/internal'/)
    }
  })

  it('write from a handler in the template', () => {
    for (const code of [compiled(SCRIPT, 'dom'), compiled(SCRIPT, undefined, true)])
      expect(code).toContain('=> KayUpdateTo(box, "count", (KayCurrent) => ++KayCurrent, "post")')
  })

  it('leave a target plainly holding no signal as written, and import nothing for it', () => {
    const plain = '---\nconst point = { x: 0, nested: { y: [1, 2] } }\nconst grid = new Uint8Array(4)\nconst seen = new Map<string, number>()\nlet total = 0\nlet typed: number = Number(\'3\')\nlet text = `a`\nfunction f() {\n  point.x = 1\n  point.nested.y[0] += 2\n  grid[1]++\n  seen.size\n  total += 1\n  typed = 3\n  text = \'b\'\n}\n---\nbutton(onClick={f}) go\n'

    for (const code of [compiled(plain, 'dom'), compiled(plain, 'html'), compiled(plain, undefined, true)]) {
      expect(code).toContain('point.x = 1\n  point.nested.y[0] += 2\n  grid[1]++')
      expect(code).toContain('total += 1\n  typed = 3\n  text = \'b\'')
      expect(code).not.toContain('KayWriteTo')
      expect(code).not.toContain('KayWriteBack')
      expect(code).not.toContain('kay/internal')
    }
  })

  it('wrap a literal holding a call, a spread or a computed key, which may hold a signal', () => {
    const code = compiled('---\nimport { signal } from \'kay\'\nconst key = \'k\'\nconst box = { count: signal(0) }\nconst spread = { ...box }\nconst computed = { [key]: 1 }\nconst list = [signal(1)]\nfunction f() {\n  box.count = 1\n  spread.count = 2\n  computed.k = 3\n  list[0] = 4\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('KayWriteTo(box, "count", 1)\n  KayWriteTo(spread, "count", 2)\n  KayWriteTo(computed, "k", 3)\n  KayWriteTo(list, 0, 4)')
  })

  it('keep a parenthesized or asserted object whole, a computed key and a parenthesized right side', () => {
    const code = compiled('---\nconst { make } = props<{ make: () => { value: string, rows: number[] } }>()\nconst target = make()\nconst at = 1\nfunction f(event: Event) {\n  ;(event.target as HTMLInputElement).value = \'x\'\n  target.rows[at + 1] = (5)\n  target.rows[ (at) ] += (2)\n  ;(target as { value: string }).value += \'!\'\n  ++target.rows[at]\n}\n---\nbutton(onClick={f}) go\n', 'html')

    expect(code).toContain(';KayWriteTo((event.target as HTMLInputElement), "value", \'x\')')
    expect(code).toContain('KayWriteTo(target.rows, at + 1, (5))')
    expect(code).toContain('KayUpdateTo(target.rows,  (at) , (KayCurrent) => KayCurrent + ((2)))')
    expect(code).toContain(';KayUpdateTo((target as { value: string }), "value", (KayCurrent) => KayCurrent + (\'!\'))')
    expect(code).toContain('KayUpdateTo(target.rows, at, (KayCurrent) => ++KayCurrent)')
  })

  it('leave an update whose value is read, or a target the helper cannot spell, as written', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nconst box = makeBox()\nlet n = makeBox().n\nclass Child extends Object {\n  set(v: number) {\n    super.x = v\n    this.y = v\n  }\n}\nfunction f() {\n  const before = n++\n  const [a = box.value] = [1]\n  ;(box.count) = 1\n  box.count!++\n  return [before, a]\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('const before = n++')
    expect(code).toContain('super.x = v')
    expect(code).toContain('this.y = v')
    expect(code).toContain(';(box.count) = 1')
    expect(code).toContain('box.count!++')
  })

  it('keep the write of a signal the compiler knows, and its checks', () => {
    const code = compiled('---\nimport { signal } from \'kay\'\nconst count = signal(0)\nlet own = signal(1)\nfunction f() {\n  count = 1\n  own += 2\n}\n---\nbutton(onClick={f}) {count()}\n', 'dom')

    expect(code).toContain('count.set(1)\n  own.set((KayCurrent) => KayCurrent + (2))')
    expect(code).not.toContain('KayWriteTo')
    expect(code).not.toContain('KayWriteBack')
    expect(compileKay('---\nimport { memo } from \'kay\'\nconst double = memo(() => 1)\nfunction f() { double = 2 }\n---\np x\n', 'test.kay').diagnostics.map(d => d.message)).toEqual(['`double` is a memo, which cannot be written'])
  })

  it('apply to a template handler, a loop row and a server fence statement', () => {
    const template = '---\nconst { items } = props<{ items: { done: boolean, hits: number }[] }>()\n---\nfor item of items key={item}\n  button(onClick={() => item.done = !item.done}) {item.hits}\n  button(onClick={() => { item.hits++ }}) up\n'

    // The server renders no handler, so only the browser and the types read these.
    for (const code of [compiled(template, 'dom'), compiled(template, undefined, true)]) {
      expect(code).toMatch(/KayWriteTo\(.*item.*, "done", !/)
      expect(code).toMatch(/KayUpdateTo\(.*item.*, "hits", \(KayCurrent\) => \+\+KayCurrent, "post"\)/)
    }

    const page = compileKay('--- server\nconst store: Record<string, number> = {}\nstore.visits = 1\nlet cache = makeCache()\ncache = makeCache()\n---\np x\n', 'src/routes/index.kay', { output: 'html', includeServer: true })

    expect(page.diagnostics.map(d => d.message)).toEqual([])
    expect(page.tsx).toContain('store.visits = 1')
    expect(page.tsx).toContain('cache = KayWriteBack(cache, makeCache())')
  })

  it('generate a statement beside an empty one once', () => {
    const code = compiled('---\nconst names = signal([\'a\'])\nconst box = makeBox()\n;(globalThis as { rows?: unknown }).rows = names\n;(box as { n: number }).n = 1\nbox.n = 2;(box as { n: number }).n = 3\n---\np {names()}\n', 'dom')

    expect(code).toContain(';KayWriteTo((globalThis as { rows?: unknown }), "rows", names)\n;KayWriteTo((box as { n: number }), "n", 1)\nKayWriteTo(box, "n", 2);KayWriteTo((box as { n: number }), "n", 3)')
  })
})

describe('assignments left as written', () => {
  it('keep a write that awaits, or holds another write, whole', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nconst box = makeBox()\nlet n = makeBox().n\nasync function f() {\n  box.total += await load()\n  n += await load()\n  box.a ??= await load()\n  n = ++box.y\n  n = box.x++\n  box.b = box.c = 1\n  box.d = (n = 2)\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('box.total += await load()')
    expect(code).toContain('n += await load()')
    expect(code).toContain('box.a ??= await load()')
    expect(code).toContain('n = KayUpdateTo(box, "y", (KayCurrent) => ++KayCurrent)')
    expect(code).toContain('n = KayUpdateTo(box, "x", (KayCurrent) => ++KayCurrent, "post")')
    expect(code).toContain('box.b = KayWriteTo(box, "c", 1)')
    expect(code).toContain('box.d = (n = KayWriteBack(n, 2))')
  })

  it('wrap a plain assignment to a member whose right side awaits, since the value is evaluated before the write', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nconst box = makeBox()\nlet n = makeBox().n\nasync function f() {\n  box.total = await load()\n  box.rows[await at()] = 1\n  n = await load()\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('KayWriteTo(box, "total", await load())')
    expect(code).toContain('box.rows[await at()] = 1')
    expect(code).toContain('n = await load()')
  })

  it('hand a let its declared type, since a plain assignment is typed by it and not by where the name was narrowed', () => {
    const code = compiled('---\nlet element: Element | null = document.body\nlet count: number = Number(\'1\')\nfunction f() {\n  for (let walk: Element | null = element; walk && walk !== document.body; walk = walk.parentElement) element = walk\n  element = null\n  element ??= document.body\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('walk = KayWriteBack<Element | null>(walk, walk.parentElement)')
    expect(code).toContain('element = KayWriteBack<Element | null>(element, walk)')
    expect(code).toContain('element = KayUpdateBack<Element | null>(element, (KayCurrent) => KayCurrent ?? (document.body))')
    expect(code).not.toContain('KayWriteBack<number>')
  })

  it('leave a field of this, and a postfix a function returns, as written', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nlet n = makeBox().n\nclass Child {\n  private hits = 0\n  bump() {\n    this.hits++\n    this.hits += 1\n  }\n}\nconst next = () => n++\nfunction f() {\n  for (let i = 0; i < 2; i++) n++\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('this.hits++\n    this.hits += 1')
    expect(code).toContain('const next = () => n++')
    expect(code).toContain('n = KayUpdateBack(n, (KayCurrent) => ++KayCurrent)')
    expect(code).toContain('i++')
  })

  it('write a logical assignment as one that writes only when the value changes', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nconst box = makeBox()\nlet n = makeBox().n\nfunction f() {\n  box.a ||= 2\n  box.b &&= 3\n  box.c ??= 4\n  n ??= 5\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('KayUpdateTo(box, "a", (KayCurrent) => KayCurrent || (2), "logical")')
    expect(code).toContain('KayUpdateTo(box, "b", (KayCurrent) => KayCurrent && (3), "logical")')
    expect(code).toContain('KayUpdateTo(box, "c", (KayCurrent) => KayCurrent ?? (4), "logical")')
    expect(code).toContain('n = KayUpdateBack(n, (KayCurrent) => KayCurrent ?? (5))')
  })

  it('wrap an empty container, which a signal may be put into, unless it is typed as holding none, and a root set again', () => {
    const code = compiled('---\nimport { makeBox } from \'./box\'\nconst loose = {}\nconst list = []\nconst seen: Record<string, number> = {}\nconst rows: Record<string, Signal<number>> = {}\nlet again = {}\nagain = makeBox()\nfunction f() {\n  loose.a = 1\n  list[0] = 1\n  seen.a = 1\n  rows.a = 1\n  again.x = 1\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('KayWriteTo(loose, "a", 1)')
    expect(code).toContain('KayWriteTo(list, 0, 1)')
    expect(code).toContain('seen.a = 1')
    expect(code).toContain('KayWriteTo(rows, "a", 1)')
    expect(code).toContain('KayWriteTo(again, "x", 1)')
  })
})

describe('a literal typed as holding no signal', () => {
  it('leaves a tuple and the empty containers inside it as written', () => {
    const code = compiled('---\nconst pair: [number, string?, ...boolean[]] = [1]\nconst named: [a: number, b: string] = [1, \'x\']\nconst nested: { list: number[], more: { rows: string[] } } = { list: [], more: { rows: [] } }\nconst loose = { list: [] }\nfunction f() {\n  pair[0] = 2\n  named[1] = \'y\'\n  nested.list[0] = 1\n  nested.more.rows[0] = \'z\'\n  loose.list[0] = 1\n}\n---\nbutton(onClick={f}) go\n', 'dom')

    expect(code).toContain('pair[0] = 2\n  named[1] = \'y\'\n  nested.list[0] = 1\n  nested.more.rows[0] = \'z\'')
    expect(code).toContain('KayWriteTo(loose.list, 0, 1)')
  })
})

describe('the runtime helpers', () => {
  it('write a signal a property holds and assign anything else', () => {
    const count = signal(1)
    const box = { count, name: 'a', double: memo(() => count() * 2) }

    expect(writeTo(box, 'count', 5)).toBe(5)
    expect(count()).toBe(5)
    expect(box.count).toBe(count)
    expect(writeTo(box, 'name', 'b')).toBe('b')
    expect(box.name).toBe('b')
    expect(writeTo(box, 'double', 3 as never) as unknown).toBe(3)
    expect(box.double as unknown).toBe(3)
  })

  it('assign a function a signal held, a signal included, rather than hand it to the signal', () => {
    const box = { count: signal(1), run: () => 1 }
    const other = signal(7)

    writeTo(box, 'count', other as never)
    expect(box.count).toBe(other)
    expect(other()).toBe(7)

    const set = () => 2

    writeTo(box, 'run', set)
    expect(box.run).toBe(set)
  })

  it('tell a signal from a function that only has a set', () => {
    const lookalike = Object.assign(() => 1, { set: (_: number) => 0 })
    const box = { lookalike }

    expect(isSignal(signal(1))).toBe(true)
    expect(isSignal(lookalike)).toBe(false)
    expect(isSignal(memo(() => 1))).toBe(false)
    expect(isSignal(null)).toBe(false)

    writeTo(box, 'lookalike', 4 as never)
    expect(box.lookalike as unknown).toBe(4)
  })

  it('read nothing a plain assignment does not, so an accessor runs once or not at all', () => {
    let reads = 0
    let writes = 0
    const element = { get scrollTop() {
      reads++

      return 0
    }, set scrollTop(value: number) {
      writes += value
    } }

    writeTo(element, 'scrollTop', 5)
    updateTo(element, 'scrollTop', current => current + 1)
    expect(reads).toBe(1)
    expect(writes).toBe(6)

    let getterReads = 0
    const readOnly = { get level() {
      getterReads++

      return 1
    } }

    expect(() => updateTo(readOnly as { level: number }, 'level', current => current + 1)).toThrow()
    expect(getterReads).toBe(1)

    const count = signal(1)
    const exposed = { get count() {
      return count
    }, set: 1 }

    writeTo(exposed as unknown as { count: number }, 'count', 4)
    expect(count()).toBe(4)
  })

  it('answer a postfix with the number it read, and a coerced operand as ++ does', () => {
    const element = { data: '5' as unknown as number }

    expect(updateTo(element, 'data', current => ++current, 'post')).toBe(5)
    expect(element.data).toBe(6)
  })

  it('write a logical assignment only when it changes the value', () => {
    const frozen = Object.freeze({ a: 1, b: Number('0') }) as { a: number, b: number }

    expect(updateTo(frozen, 'a', current => current || 2, 'logical')).toBe(1)
    expect(() => updateTo(frozen, 'b', current => current || 2, 'logical')).toThrow(TypeError)

    const box = { count: signal(1) }
    let writes = 0

    box.count.set = () => {
      writes++
    }
    updateTo(box, 'count', current => current || 2, 'logical')
    expect(writes).toBe(0)
  })

  it('count a selection as a signal', () => {
    const picked = selection<string>('a')
    const box = { picked }

    writeTo(box, 'picked', 'b' as never)
    expect(picked()).toBe('b')
    expect(box.picked).toBe(picked)
  })

  it('update a signal or a value from its current one, answering the new or the old', () => {
    const count = signal(1)
    const box = { count, n: 1, list: [signal(5)] }

    expect(updateTo(box, 'count', current => current + 1)).toBe(2)
    expect(updateTo(box, 'count', current => current + 1, 'post')).toBe(2)
    expect(count()).toBe(3)
    expect(updateTo(box, 'n', current => current + 1)).toBe(2)
    expect(updateTo(box, 'n', current => current + 1, 'post')).toBe(2)
    expect(box.n).toBe(3)
    expect(updateTo(box.list, 0, current => current * 2)).toBe(10)
    expect(box.list[0]!()).toBe(10)
  })

  it('write a variable holding a signal and leave it the signal, replace one holding anything else', () => {
    const count = signal(1)
    let picked: unknown = count

    picked = writeBack(picked, 3)
    expect(picked).toBe(count)
    expect(count()).toBe(3)
    picked = updateBack(picked, current => Number(current) + 1)
    expect(picked).toBe(count)
    expect(count()).toBe(4)

    let plain: unknown = 1

    plain = writeBack(plain, 2)
    expect(plain).toBe(2)
    plain = updateBack(plain, current => Number(current) * 5)
    expect(plain).toBe(10)

    const other = signal(0)

    picked = writeBack(picked, other as never)
    expect(picked).toBe(other)
  })
})
