import { outbox } from '@kaynooo/kayjs-mail'
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import board from '../src/api/board'
import { auth } from '../src/auth'
import { post } from '../src/routes/index.kay'
import { } from './members'

// The site takes the plugins of kay.config.ts's extensions, the mailer's queue included, which `runJobs()` also drains here and now.
const site = await testSite()

it('shows an empty board, and the button to pin a notice to members only', async () => {
  const home = await site.visit('/')

  expect(home.find('.kui-empty-state')).toHaveLength(1)
  expect(home.html).not.toContain('Pin a notice')
  await expect(site.call(post, { title: 'Hello', body: 'Anyone?' })).rejects.toMatchObject({ status: 401, data: { error: 'Sign in to pin a notice' } })
})

it('pins a notice, which every open board hears of at once and confirmed members by mail', async () => {
  const reader = (await auth.signInAs(site, { email: 'ada@example.com', username: 'Ada', emailVerified: true })).email!
  const unconfirmed = (await auth.signInAs(site, { email: 'linus@example.com', username: 'Linus' })).email!

  auth.signOut(site)

  const watching = site.socket(board, '/')

  expect(await watching.next()).toEqual({ type: 'present', names: [], guests: 1 })

  const author = (await auth.signInAs(site, { email: 'grace@example.com', username: 'Grace', emailVerified: true })).email!
  const live = site.socket(board, '/')

  expect(await watching.next()).toEqual({ type: 'present', names: ['Grace'], guests: 1 })
  expect(await live.next()).toEqual({ type: 'present', names: ['Grace'], guests: 1 })
  expect((await site.visit('/')).html).toContain('Pin a notice')

  outbox.clear()

  const { id } = await site.call(post, { title: 'Bake sale', body: 'Saturday at ten,\nin the hall.' })

  expect(await watching.next()).toEqual({ type: 'posted', notice: { id, title: 'Bake sale', author: 'Grace' } })
  expect(await live.next()).toEqual({ type: 'posted', notice: { id, title: 'Bake sale', author: 'Grace' } })

  const home = await site.visit('/')

  expect(home.find('.kui-card [data-part=title]').map(title => title.text)).toEqual(['Bake sale'])
  expect(home.find('.kui-card p')[0]?.text).toBe('Saturday at ten, in the hall.')
  expect((await site.visit(`/notices/${id}`)).title()).toBe('Bake sale | Noticeboard')

  // The queue runs the announcement, which queues one mail per confirmed member but the author, sent as the queues drain.
  await outbox.waitFor(reader, { site })
  expect(outbox.to(reader).map(each => each.subject)).toEqual(['New notice: Bake sale'])
  expect(outbox.to(reader)[0]!.html).toContain(`http://localhost/notices/${id}`)
  expect(outbox.to(author)).toEqual([])
  expect(outbox.to(unconfirmed)).toEqual([])

  live.close()
  expect(await watching.next()).toEqual({ type: 'present', names: [], guests: 1 })
  watching.close()
})

it('refuses an empty notice with the field it is missing', async () => {
  await auth.signInAs(site, { email: 'barbara@example.com', username: 'Barbara' })
  await expect(site.call(post, { title: ' ', body: 'Text' })).rejects.toMatchObject({ status: 422, errors: { title: 'Write a title' } })
})
