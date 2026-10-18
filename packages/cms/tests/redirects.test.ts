import { describe, expect, test } from 'bun:test'
import { addRedirect, readMissing, removeRedirect } from '../src/missing'

describe('adding a redirect from the screen', () => {
  test('lists it with its Remove, and removes it', () => {
    expect(addRedirect('/old-cms-page', '/new-page')).toBeUndefined()

    const screen = readMissing()

    expect('added' in screen && screen.added).toContainEqual({ from: '/old-cms-page', to: '/new-page', status: 307 })
    expect(removeRedirect('/old-cms-page')).toBe(true)
    expect(removeRedirect('/old-cms-page')).toBe(false)
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })

  test('answers 307, or 308 when made permanent', () => {
    expect(addRedirect('/old-cms-a', '/new-page')).toBeUndefined()
    expect(addRedirect('/old-cms-b', '/new-page', true)).toBeUndefined()

    const screen = readMissing()
    const added = 'added' in screen ? screen.added : []

    expect(added.filter(row => row.from.startsWith('/old-cms-')).map(row => [row.from, row.status])).toEqual(expect.arrayContaining([['/old-cms-a', 307], ['/old-cms-b', 308]]))
    expect(removeRedirect('/old-cms-a')).toBe(true)
    expect(removeRedirect('/old-cms-b')).toBe(true)
  })

  test('words a refusal for an editor who aims at another site, a loop, or hostile text', () => {
    for (const target of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1'])
      expect(addRedirect('/hostile', target)).toEqual(expect.any(String))

    expect(addRedirect('/loop', '/loop')).toMatch(/loop/)
    expect(addRedirect('//evil.example', '/ok')).toEqual(expect.any(String))
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })
})
