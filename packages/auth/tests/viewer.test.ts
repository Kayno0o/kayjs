import type { Auth } from '../src/auth'
import type { User } from '../src/core'
import { afterEach, expect, test } from 'bun:test'
import { currentRequest } from 'kay/library'
import { currentUser, isSignedOut, loadViewer, readRequestWith, registerViewer } from '../src/viewer'

// Bun shares modules between test files, so the reader `createAuth` set goes back after each test.
afterEach(() => readRequestWith(currentRequest))

const user = (fields: Partial<User>) => ({ id: 'u1', roles: [], guest: false, ...fields }) as User
const isGranted = (role: string, found: User) => found.roles.includes(role)

function answering(found: User | null) {
  const request = new Request('http://localhost/')
  let reads = 0

  registerViewer(request, { auth: { user: async () => {
    reads++

    return found
  } } as unknown as Auth, isGranted })
  readRequestWith(() => request)

  return { request, reads: () => reads }
}

test('outside a request, the components say a prerendered page cannot show the user', () => {
  readRequestWith(() => undefined)
  expect(async () => currentUser()).toThrow('cannot render in a prerendered page')
})

test('without a layout loading it, the user is a promise a block waits for, read once per call', async () => {
  const { reads } = answering(user({ roles: ['admin'] }))

  expect(await currentUser()).toMatchObject({ id: 'u1' })
  expect(await currentUser('admin')).toMatchObject({ id: 'u1' })
  expect(await currentUser('editor')).toBeNull()
  expect(await isSignedOut()).toBe(false)
  expect(reads()).toBe(4)
})

test('with the layout loading it, the user is the value itself and the store is read once', async () => {
  const { request, reads } = answering(user({ roles: ['admin'] }))

  await loadViewer(request)

  expect(currentUser()).toMatchObject({ id: 'u1' })
  expect(currentUser('admin')).toMatchObject({ id: 'u1' })
  expect(currentUser('editor')).toBeNull()
  expect(isSignedOut()).toBe(false)
  expect(reads()).toBe(1)
})

test('a visitor and a guest are signed out', async () => {
  for (const found of [null, user({ guest: true })]) {
    const { request } = answering(found)

    await loadViewer(request)
    expect(currentUser()).toBeNull()
    expect(isSignedOut()).toBe(true)
  }
})

test('a failed read ahead leaves it to the component, which reads again', async () => {
  const request = new Request('http://localhost/')
  let reads = 0

  registerViewer(request, { auth: { user: async () => {
    if (reads++ === 0)
      throw new Error('store down')

    return user({})
  } } as unknown as Auth, isGranted })
  readRequestWith(() => request)
  await loadViewer(request)

  expect(await currentUser()).toMatchObject({ id: 'u1' })
})
