import type { TestApp } from '@kayjs/kay/test'
import { beforeAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { testApp } from '@kayjs/kay/test'

const root = resolve(import.meta.dir, '..')
process.env.AUTH_DB ??= ':memory:'

describe('__APP_NAME__', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await testApp({ root })
  })

  it('renders the home and login pages', async () => {
    const home = await app.get('/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Welcome to __APP_NAME__')

    const login = await app.get('/login')
    expect(login.status).toBe(200)
    expect(await login.text()).toContain('/auth/signin')
    expect(app.errors).toEqual([])
  })

  it('redirects unauthenticated requests from /dashboard to /login', async () => {
    const res = await app.get('/dashboard')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?next=%2Fdashboard')
  })
})
