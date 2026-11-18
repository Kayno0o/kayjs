import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const site = await testSite({ guards: { default: 'open' }, root: 'tests/fixtures/site' })

describe('site.fetchStub', () => {
  it('answers a call to the matching address and lists what it received', async () => {
    const stub = site.fetchStub({ 'https://api.example.test/*': { ok: true } })
    const response = await fetch('https://api.example.test/v1/orders?page=2', { method: 'POST', body: '{"id":1}' })

    expect(await response.json()).toEqual({ ok: true })
    expect(stub.requests.map(request => [request.method, request.url, request.path, request.query.get('page'), request.json()])).toEqual([['POST', 'https://api.example.test/v1/orders?page=2', '/v1/orders', '2', { id: 1 }]])
  })

  it('takes a method in front of the pattern, a function and a Response, the latest stub winning', async () => {
    site.fetchStub({ 'https://api.example.test/*': 'early' })
    site.fetchStub({ 'GET https://api.example.test/hello': request => `hi ${request.method}`, 'POST https://api.example.test/hello': new Response('made', { status: 201 }) })

    expect(await (await fetch('https://api.example.test/hello')).text()).toBe('hi GET')

    const posted = await fetch('https://api.example.test/hello', { method: 'POST' })

    expect([posted.status, await posted.text()]).toEqual([201, 'made'])
    expect(await (await fetch('https://api.example.test/other')).text()).toBe('early')
  })

  it('forgets the stubs of the test before it', async () => {
    await expect(fetch('https://api.example.test/hello')).rejects.toThrow('no stub answers')
  })

  it('fails a call to another host that no stub answers, and lets loopback through', async () => {
    await expect(fetch('https://unstubbed.example.test/x')).rejects.toThrow(/outgoing GET https:\/\/unstubbed\.example\.test\/x that no stub answers/)

    using server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('local') })

    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('local')
  })
})

describe('site.freezeTime', () => {
  it('stops the clock at the date, and advance goes on from it', async () => {
    const frozen = site.freezeTime('2026-03-01T10:00:00Z')

    await Bun.sleep(15)
    expect(Date.now()).toBe(frozen.getTime())

    await site.advance('1h')
    expect(new Date().toISOString()).toBe('2026-03-01T11:00:00.000Z')
  })

  it('puts the real time back after the test', () => {
    expect(new Date().getFullYear()).toBeGreaterThanOrEqual(2026)
    expect(new Date().toISOString()).not.toBe('2026-03-01T11:00:00.000Z')
  })

  it('refuses a date it cannot read', () => {
    expect(() => site.freezeTime('soon')).toThrow('cannot read soon as a date')
  })
})

describe('site.signInAs', () => {
  it('fails while no library joined', async () => {
    await expect(site.signInAs({})).rejects.toThrow('call `test(site)`')
  })

  it('signs in through every hook that has something to do, a second hook of a name replacing the first', async () => {
    const calls: string[] = []

    site.joinSignIn({ name: 'one', signIn: async () => {
      calls.push('one:old')

      return undefined
    }, signOut: () => void calls.push('one:out') })
    site.joinSignIn({ name: 'one', signIn: async () => {
      calls.push('one')

      return { role: 'admin' } as never
    }, signOut: () => void calls.push('one:out') })
    site.joinSignIn({ name: 'two', signIn: async () => undefined, signOut: () => void calls.push('two:out') })

    expect(await site.signInAs({})).toEqual({ role: 'admin' } as never)
    site.signOut()
    expect(calls).toEqual(['one', 'one:out', 'two:out'])
  })
})

describe('refusal names', () => {
  it('keeps the old names as the same functions', () => {
    expect(site.refusal).toBe(site.expectRefused)
    expect(site.socketRefusal).toBe(site.socket.refused)
  })

  it('keeps the hooks of each as() view to that view', async () => {
    const calls: string[] = []
    const first = site.as('a=1')
    const second = site.as('b=2')

    first.joinSignIn({ name: 'lib', signIn: async () => {
      calls.push('first')

      return { role: 'a' } as never
    }, signOut: () => void calls.push('first:out') })
    second.joinSignIn({ name: 'lib', signIn: async () => {
      calls.push('second')

      return { role: 'b' } as never
    }, signOut: () => void calls.push('second:out') })

    expect(await first.signInAs({})).toEqual({ role: 'a' } as never)
    first.signOut()
    expect(calls).toEqual(['first', 'first:out'])
  })
})
