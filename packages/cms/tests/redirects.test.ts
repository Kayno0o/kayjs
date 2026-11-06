import { describe, expect, test } from 'bun:test'
import { addRedirect, clearPaths, dismissPaths, readMissing, removeRedirects, sitePathsLike } from '../src/missing'

async function added() {
  const screen = await readMissing()

  return 'added' in screen ? screen.added : []
}

describe('adding a redirect from the screen', () => {
  test('lists it with its Remove, and removes it', async () => {
    expect(await addRedirect('/old-cms-page', '/new-page')).toBeUndefined()

    const screen = await readMissing()

    expect('added' in screen && screen.added).toContainEqual(expect.objectContaining({ from: '/old-cms-page', to: '/new-page', status: 307, at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) }))
    expect(await removeRedirects(['/old-cms-page'])).toBe(1)
    expect(await removeRedirects(['/old-cms-page'])).toBe(0)
    expect(await readMissing()).toMatchObject({ added: [] })
  })

  test('answers 307, or 308 when made permanent', async () => {
    expect(await addRedirect('/old-cms-a', '/new-page')).toBeUndefined()
    expect(await addRedirect('/old-cms-b', '/new-page', 308)).toBeUndefined()

    expect((await added()).filter(row => row.from.startsWith('/old-cms-')).map(row => [row.from, row.status])).toEqual(expect.arrayContaining([['/old-cms-a', 307], ['/old-cms-b', 308]]))
    expect(await removeRedirects(['/old-cms-a', '/old-cms-b'])).toBe(2)
  })

  test('words a refusal for an editor who aims at another site, a loop, or hostile text', async () => {
    for (const target of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1'])
      expect(await addRedirect('/hostile', target)).toEqual(expect.any(String))

    expect(await addRedirect('/loop', '/loop')).toMatch(/loop/)
    expect(await addRedirect('//evil.example', '/ok')).toEqual(expect.any(String))
    expect(await readMissing()).toMatchObject({ added: [] })
  })

  test('keeps 1000 redirects, tells the editor when the set is full, and still edits one of them', async () => {
    for (let index = 0; index < 1000; index++)
      expect(await addRedirect(`/full-${index}`, '/new-page')).toBeUndefined()

    try {
      expect(await addRedirect('/full-one-more', '/new-page')).toMatch(/1000/)
      expect(await addRedirect('/full-1', '/other-page')).toBeUndefined()
      expect((await added()).filter(row => row.from.startsWith('/full-'))).toHaveLength(1000)
    }
    finally {
      await removeRedirects(Array.from({ length: 1000 }, (_, index) => `/full-${index}`))
    }

    expect((await added())).toEqual([])
  })

  test('edits a redirect in place: the same path takes a new target and status, and may become gone', async () => {
    expect(await addRedirect('/edit-cms', '/new-page')).toBeUndefined()
    expect(await addRedirect('/edit-cms', '/about', 308)).toBeUndefined()
    expect((await added()).filter(row => row.from === '/edit-cms').map(row => [row.to, row.status])).toEqual([['/about', 308]])
    expect(await addRedirect('/edit-cms', '', 410)).toBeUndefined()
    expect((await added()).filter(row => row.from === '/edit-cms').map(row => [row.to, row.status])).toEqual([['', 410]])
    expect(await removeRedirects(['/edit-cms'])).toBe(1)
  })

  test('removes several at once, counting those that were there', async () => {
    await addRedirect('/bulk-a', '/new-page')
    await addRedirect('/bulk-b', '', 410)

    expect(await removeRedirects(['/bulk-a', '/bulk-b', '/bulk-none'])).toBe(2)
  })

  test('lists the config\'s redirects for the screen, and the site\'s paths only for a target typed', async () => {
    const screen = await readMissing()

    expect('configured' in screen && screen.configured).toEqual(expect.any(Array))
    expect('paths' in screen).toBe(false)
    expect(sitePathsLike('abo')).toEqual(expect.any(Array))
  })
})

describe('dismissing missing paths', () => {
  test('counts what it forgot, none for a path not listed', async () => {
    expect(await dismissPaths(['/never-listed'])).toBe(0)
    expect(await clearPaths()).toEqual(expect.any(Number))
  })
})
