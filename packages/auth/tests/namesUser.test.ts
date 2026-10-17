import { describe, expect, test } from 'bun:test'
import { testApp } from './helpers/app'

describe('naming the user to other libraries', () => {
  test('userOf answers the signed-in user\'s id for the request, and nothing for an anonymous one', async () => {
    const { browser } = testApp()
    const ada = browser()

    expect(await ada.json('/named')).toBe('anonymous')

    const registered = await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })

    expect(await ada.json('/named')).toBe((registered as { user: { id: string } }).user.id)
    expect(await browser().json('/named')).toBe('anonymous')
  })

  test('a guest is not named', async () => {
    const guest = testApp().browser()

    await guest.callOk('signInAsGuest')

    expect(await guest.json('/named')).toBe('anonymous')
  })
})
