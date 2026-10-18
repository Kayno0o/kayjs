import { describe, expect, test } from 'bun:test'
import { addRedirect, readMissing, removeRedirect } from '../src/missing'

describe('adding a redirect from the screen', () => {
  test('lists it with its Remove, and removes it', () => {
    expect(addRedirect('/old-cms-page', '/new-page')).toBeUndefined()

    const screen = readMissing()

    expect('added' in screen && screen.added).toContainEqual({ from: '/old-cms-page', to: '/new-page', status: 308 })
    expect(removeRedirect('/old-cms-page')).toBe(true)
    expect(removeRedirect('/old-cms-page')).toBe(false)
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })

  test('words a refusal for an editor who aims at another site, a loop, or hostile text', () => {
    for (const target of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1'])
      expect(addRedirect('/hostile', target)).toEqual(expect.any(String))

    expect(addRedirect('/loop', '/loop')).toMatch(/loop/)
    expect(addRedirect('//evil.example', '/ok')).toEqual(expect.any(String))
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })
})
