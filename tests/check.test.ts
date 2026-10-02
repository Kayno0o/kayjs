import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { check } from '../src/check'

const fixtures = join(import.meta.dir, 'fixtures')

describe('kay check', () => {
  it('passes a valid app, .ts files importing .kay components included', async () => {
    expect(await check(join(fixtures, 'app'))).toEqual([])
  })

  it('passes a site of pages, layouts and islands, with route params and server data typed', async () => {
    expect(await check(join(fixtures, 'site'))).toEqual([])
  })

  it('reports type errors at the line and column of the .kay source', async () => {
    const diagnostics = await check(join(fixtures, 'broken'))
    const brief = diagnostics.map(d => ({ file: d.file.slice(fixtures.length + 1), line: d.line, column: d.column, code: d.code, message: firstLine(d.message) }))

    expect(brief).toEqual([
      { file: 'broken/src/routes/[id].kay', line: 2, column: 30, code: 'TS2339', message: 'Property \'slug\' does not exist on type \'{ id: string; }\'.' },
      { file: 'broken/src/routes/[id].kay', line: 5, column: 9, code: 'TS2551', message: expect.stringContaining('Property \'nam\' does not exist') },
      { file: 'broken/src/routes/form.kay', line: 8, column: 15, code: 'TS2345', message: 'Argument of type \'"titel"\' is not assignable to parameter of type \'"title"\'.' },
      { file: 'broken/src/routes/links.kay', line: 5, column: 9, code: 'TS2345', message: expect.stringContaining('No page serves /form/extra') },
      { file: 'broken/src/routes/links.kay', line: 8, column: 16, code: 'TS2345', message: expect.stringContaining('An island receives its props as JSON') },
      { file: 'broken/src/routes/links.kay', line: 8, column: 36, code: 'TS2345', message: expect.stringContaining('An island receives its props as JSON') },
      { file: 'broken/src/todo-item.kay', line: 7, column: 14, code: 'TS2551', message: 'Property \'titel\' does not exist on type \'Todo\'. Did you mean \'title\'?' },
      { file: 'broken/src/todo-item.kay', line: 8, column: 5, code: 'TS2322', message: expect.stringContaining('hreff') },
      { file: 'broken/src/todo-list.kay', line: 5, column: 3, code: 'TS2322', message: expect.stringContaining('IntrinsicAttributes & { todo: Todo; }') },
      { file: 'broken/src/main.ts', line: 3, column: 38, code: 'TS2741', message: expect.stringContaining('\'done\' is missing') },
    ])
  })
})

function firstLine(text: string): string {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}
