import { expect, it } from 'bun:test'
import { persisted } from '../src/runtime'
import { inServerScope } from '../src/server/scope'
import { persistedCookie } from '../src/test'

// No DOM is registered here, so the signals read as they do while a request renders.
const report = () => undefined

function render(cookie: string): unknown[] {
  const request = new Request('http://localhost/', { headers: { cookie } })

  return inServerScope(request, report, () => [persisted.cookie('tone', 'peach')(), persisted('theme', 'light')(), persisted.local('draft', 'none')(), persisted.session('step', 'one')()])
}

it('renders persisted.cookie from the request cookie, as persisted() does', () => {
  expect(render([persistedCookie('tone', 'blue'), persistedCookie('theme', 'dark')].join('; '))).toEqual(['blue', 'dark', 'none', 'one'])
  expect(render('')).toEqual(['peach', 'light', 'none', 'one'])
})

it('renders persisted.local and persisted.session as their default, a cookie of their name left unread', () => {
  expect(render([persistedCookie('draft', 'typed'), persistedCookie('step', 'two')].join('; '))).toEqual(['peach', 'light', 'none', 'one'])
})
