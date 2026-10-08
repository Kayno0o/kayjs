import { outbox } from '@kaynooo/kayjs-mail'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import board from '../src/api/board'
import { auth } from '../src/auth'
import { signOut } from '../src/routes/account/index.kay'
import { post } from '../src/routes/index.kay'
import { joinAs } from './members'

// The mailer is left out: its plugin would run the queue as soon as a test starts the server, where `runJobs()` runs it here and now.
const site = await testSite({ use: [auth.plugin] })

afterAll(async () => {
  await site.close()
})

it('shows an empty board, and the button to pin a notice to members only', async () => {
  const home = await site.visit('/')

  expect(home.find('.kui-empty-state')).toHaveLength(1)
  expect(home.html).not.toContain('Pin a notice')
  await expect(site.call(post, { title: 'Hello', body: 'Anyone?' })).rejects.toMatchObject({ status: 401, data: { error: 'Sign in to pin a notice' } })
})

it('pins a notice, which every open board hears of at once and confirmed members by mail', async () => {
  const reader = await joinAs(site, 'Ada', { confirmed: true })
  const unconfirmed = await joinAs(site, 'Linus')

  await site.submit(signOut, {}, { from: '/account' })

  const watching = site.socket(board, '/')

  expect(await watching.next()).toEqual({ type: 'present', names: [], guests: 1 })

  const author = await joinAs(site, 'Grace', { confirmed: true })
  const live = site.socket(board, '/')

  expect(await watching.next()).toEqual({ type: 'present', names: ['Grace'], guests: 1 })
  expect(await live.next()).toEqual({ type: 'present', names: ['Grace'], guests: 1 })
  expect((await site.visit('/')).html).toContain('Pin a notice')

  outbox.clear()

  const { id } = await site.call(post, { title: 'Bake sale', body: 'Saturday at ten,\nin the hall.' })

  expect(await watching.next()).toEqual({ type: 'posted', notice: { id, title: 'Bake sale', author: 'Grace' } })
  expect(await live.next()).toEqual({ type: 'posted', notice: { id, title: 'Bake sale', author: 'Grace' } })

  const home = await site.visit('/')

  expect(home.find('.kui-card-title').map(title => title.text)).toEqual(['Bake sale'])
  expect(home.find('.kui-card p')[0]?.text).toBe('Saturday at ten, in the hall.')
  expect((await site.visit(`/notices/${id}`)).title()).toBe('Bake sale | Noticeboard')

  // The queue runs the announcement, which queues one mail per confirmed member but the author, sent as the queues drain.
  expect(await site.runJobs()).toBe(2)
  expect(outbox.to(reader).map(each => each.subject)).toEqual(['New notice: Bake sale'])
  expect(outbox.to(reader)[0]!.html).toContain(`http://localhost:3000/notices/${id}`)
  expect(outbox.to(author)).toEqual([])
  expect(outbox.to(unconfirmed)).toEqual([])

  live.close()
  expect(await watching.next()).toEqual({ type: 'present', names: [], guests: 1 })
  watching.close()
})

it('refuses an empty notice with the field it is missing', async () => {
  await joinAs(site, 'Barbara')
  await expect(site.call(post, { title: ' ', body: 'Text' })).rejects.toMatchObject({ status: 422, errors: { title: 'Write a title' } })
})
