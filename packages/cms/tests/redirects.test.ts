import { describe, expect, test } from 'bun:test'
import { addRedirect, clearPaths, dismissPaths, readMissing, removeRedirects, sitePathsLike } from '../src/missing'

function added() {
  const screen = readMissing()

  return 'added' in screen ? screen.added : []
}

describe('adding a redirect from the screen', () => {
  test('lists it with its Remove, and removes it', () => {
    expect(addRedirect('/old-cms-page', '/new-page')).toBeUndefined()

    const screen = readMissing()

    expect('added' in screen && screen.added).toContainEqual(expect.objectContaining({ from: '/old-cms-page', to: '/new-page', status: 307, at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) }))
    expect(removeRedirects(['/old-cms-page'])).toBe(1)
    expect(removeRedirects(['/old-cms-page'])).toBe(0)
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })

  test('answers 307, or 308 when made permanent', () => {
    expect(addRedirect('/old-cms-a', '/new-page')).toBeUndefined()
    expect(addRedirect('/old-cms-b', '/new-page', 308)).toBeUndefined()

    expect(added().filter(row => row.from.startsWith('/old-cms-')).map(row => [row.from, row.status])).toEqual(expect.arrayContaining([['/old-cms-a', 307], ['/old-cms-b', 308]]))
    expect(removeRedirects(['/old-cms-a', '/old-cms-b'])).toBe(2)
  })

  test('words a refusal for an editor who aims at another site, a loop, or hostile text', () => {
    for (const target of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1'])
      expect(addRedirect('/hostile', target)).toEqual(expect.any(String))

    expect(addRedirect('/loop', '/loop')).toMatch(/loop/)
    expect(addRedirect('//evil.example', '/ok')).toEqual(expect.any(String))
    expect('added' in readMissing() && readMissing()).toMatchObject({ added: [] })
  })

  test('edits a redirect in place: the same path takes a new target and status, and may become gone', () => {
    expect(addRedirect('/edit-cms', '/new-page')).toBeUndefined()
    expect(addRedirect('/edit-cms', '/about', 308)).toBeUndefined()
    expect(added().filter(row => row.from === '/edit-cms').map(row => [row.to, row.status])).toEqual([['/about', 308]])
    expect(addRedirect('/edit-cms', '', 410)).toBeUndefined()
    expect(added().filter(row => row.from === '/edit-cms').map(row => [row.to, row.status])).toEqual([['', 410]])
    expect(removeRedirects(['/edit-cms'])).toBe(1)
  })

  test('removes several at once, counting those that were there', () => {
    addRedirect('/bulk-a', '/new-page')
    addRedirect('/bulk-b', '', 410)

    expect(removeRedirects(['/bulk-a', '/bulk-b', '/bulk-none'])).toBe(2)
  })

  test('lists the config\'s redirects for the screen, and the site\'s paths only for a target typed', () => {
    const screen = readMissing()

    expect('configured' in screen && screen.configured).toEqual(expect.any(Array))
    expect('paths' in screen).toBe(false)
    expect(sitePathsLike('abo')).toEqual(expect.any(Array))
  })
})

describe('dismissing missing paths', () => {
  test('counts what it forgot, none for a path not listed', () => {
    expect(dismissPaths(['/never-listed'])).toBe(0)
    expect(clearPaths()).toEqual(expect.any(Number))
  })
})
