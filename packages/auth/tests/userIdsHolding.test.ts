import { describe, expect, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

async function setup() {
  const app = testApp({})
  const member = async (email: string, roles: string[] = []) => {
    const browser = app.browser()
    const { user } = await browser.callHas('user', 'password.register', { email, password: PASSWORD })

    await app.store.users.update(user.id, { roles })

    return { browser, id: user.id }
  }

  return { ...app, member }
}

describe('userIdsHolding', () => {
  test('lists the users holding a role or one above it, for a signed-in user, banned ones left out', async () => {
    const { member, store } = await setup()
    const ada = await member('ada@example.com')
    const ed = await member('ed@example.com', ['editor'])
    const root = await member('root@example.com', ['admin'])
    const barred = await member('barred@example.com', ['editor'])

    await store.users.update(barred.id, { bannedAt: new Date(), bannedUntil: null, banReason: 'x' })

    expect((await ada.browser.call('userIdsHolding', 'editor')).sort()).toEqual([ed.id, root.id].sort())
    expect(await ada.browser.call('userIdsHolding', 'admin')).toEqual([root.id])
    expect(await ada.browser.call('userIdsHolding', 'nobody')).toEqual([])
  })

  test('answers nothing to a visitor who is not signed in', async () => {
    const { member, browser } = await setup()

    await member('ed@example.com', ['editor'])
    expect(await browser().call('userIdsHolding', 'editor')).toEqual([])
  })
})
