import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'
import { authExtension, authPages } from '../src/pages'
import { testApp, userRecord } from './helpers/app'

const devCode = process.env.KAY_DEV_CODE

afterEach(() => {
  if (devCode === undefined)
    delete process.env.KAY_DEV_CODE
  else
    process.env.KAY_DEV_CODE = devCode
})

describe('the dev tool\'s Auth tab', () => {
  test('answers the session\'s user under kay dev, and nobody before sign-in', async () => {
    process.env.KAY_DEV_CODE = '0'

    const { browser, store } = testApp()
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', roles: ['admin'] }))

    const anonymous = await ada.fetch('/_kay/auth')

    expect(anonymous.headers.get('cache-control')).toBe('no-store')
    expect(await anonymous.json()).toEqual({ user: null, via: null, signOut: '/auth/sign-out' })

    await ada.post('/sign-in/u1', {})

    expect(await ada.json('/_kay/auth')).toMatchObject({ user: { id: 'u1', email: 'ada@example.com', roles: ['admin'] }, via: 'session' })
  })

  test('is not mounted outside kay dev', async () => {
    delete process.env.KAY_DEV_CODE

    expect((await testApp().browser().fetch('/_kay/auth')).status).toBe(404)
  })

  test('is named by both extensions, as one file', () => {
    const extension = authExtension(async () => ({ auth: { plugin: testApp().auth.plugin } }))
    const pages = authPages()

    expect(extension.devTool).toEqual(pages.devTool)
    expect(existsSync(pages.devTool!.module)).toBe(true)
  })
})
