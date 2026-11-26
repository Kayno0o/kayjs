import type { ActionResult } from '@kayjs/kay/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effect, root, useAction } from '@kayjs/kay'
import { actionStub } from '../src/dom/action'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('useAction progressive form controller (#3555)', () => {
  it('tracks pending, error, fieldErrors, data, reset, and onSuccess without boilerplate signals', async () => {
    let resolveNext: ((res: ActionResult<{ id: number, title: string }>) => void) | undefined
    const receivedInputs: unknown[] = []
    const mockAction = Object.assign(
      (input: { title: string } | FormData) => {
        receivedInputs.push(input)
        return new Promise<ActionResult<{ id: number, title: string }>>((resolve) => {
          resolveNext = resolve
        })
      },
      { url: '/_kay/action/create-1234', toString: () => '/_kay/action/create-1234' },
    )

    const successes: Array<{ id: number, title: string }> = []
    const form = useAction(mockAction, {
      reset: true,
      onSuccess(created) {
        successes.push(created)
      },
    })

    expect(form.action).toBe('/_kay/action/create-1234')
    expect(form.pending.value).toBe(false)
    expect(form.error.value).toBe('')
    expect(form.fieldErrors.value).toEqual({})

    // 1. Validation failure populates error + fieldErrors, blocks double-submit while pending
    const p1 = form.submit({ title: '' })
    expect(form.pending.value).toBe(true)
    // Concurrent submit while pending is ignored
    expect(await form.submit({ title: 'ignored' })).toBeUndefined()
    expect(receivedInputs.length).toBe(1)

    resolveNext!({ ok: false, status: 400, error: 'Validation failed', fieldErrors: { title: 'Write a title' } })
    const r1 = await p1
    expect(r1?.ok).toBe(false)
    expect(form.pending.value).toBe(false)
    expect(form.error.value).toBe('Validation failed')
    expect(form.fieldErrors.value.title).toBe('Write a title')

    // 2. Success clears errors, resets HTMLFormElement, and calls typed onSuccess
    let formResetCalls = 0
    const fakeForm = { reset() { formResetCalls++ } } as unknown as HTMLFormElement
    const p2 = form.submit({ title: 'Hello' }, fakeForm)
    expect(form.pending.value).toBe(true)
    expect(form.error.value).toBe('')
    expect(form.fieldErrors.value).toEqual({})

    resolveNext!({ ok: true, data: { id: 7, title: 'Hello' } })
    const r2 = await p2
    expect(r2).toEqual({ ok: true, data: { id: 7, title: 'Hello' } })
    expect(form.pending.value).toBe(false)
    expect(form.data.value).toEqual({ id: 7, title: 'Hello' })
    expect(formResetCalls).toBe(1)
    expect(successes).toEqual([{ id: 7, title: 'Hello' }])

    // 3. reset() clears state
    form.reset()
    expect(form.data.value).toBeUndefined()
    expect(form.error.value).toBe('')
    expect(form.fieldErrors.value).toEqual({})
  })

  it('works progressively without JS (SSR action URL + 303 flash) and via FormData fetch with JS', async () => {
    const dir = makeTemp('kay-use-action-')
    mkdirSync(join(dir, 'src/actions'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/actions/notes.ts'), `
      import { action } from '@kayjs/kay/server'
      const schema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate(raw: unknown) {
            const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const title = typeof o.title === 'string' ? o.title.trim() : ''
            if (!title)
              return { issues: [{ message: 'Title is required', path: ['title'] }] }
            return { value: { title } }
          },
        },
      }
      export const createNote = action(schema, async (input) => ({ saved: input.title }))
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { useAction } from '@kayjs/kay'
      import { createNote } from '../actions/notes'

      export default function NotesPage() {
        const form = useAction(createNote, { reset: true })
        return (
          <form action={createNote} method="post" onSubmit={form.onSubmit}>
            <input name="title" />
            {form.fieldErrors.value.title && <p class="field-err">{form.fieldErrors.value.title}</p>}
            <button type="submit" disabled={form.pending.value}>Save</button>
          </form>
        )
      }
    `)

    const app = await testApp({ root: dir })
    const html = await (await app.get('/')).text()
    const match = /action="(\/_kay\/action\/createnote-[^"]+)"/.exec(html)
    expect(match).not.toBeNull()
    const actionUrl = match![1]!

    // 1. No-JS progressive submit with invalid form redirects 303 + flashes validation error
    const noJsRes = await app.fetch(new Request(`http://localhost${actionUrl}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'text/html',
        'origin': 'http://localhost',
        'referer': 'http://localhost/',
      },
      body: 'title=',
    }))
    expect(noJsRes.status).toBe(303)

    // 2. Enhanced FormData submit via actionStub + useAction reaches fieldErrors on failure and data on success
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('origin', 'http://localhost')
      return app.fetch(new Request(`http://localhost${url}`, { ...init, headers }))
    }) as typeof fetch

    try {
      const stub = actionStub<{ title: string }, { saved: string }>(actionUrl)
      const form = useAction(stub)

      const badFd = new FormData()
      badFd.set('title', '   ')
      await form.submit(badFd)
      expect(form.error.value).toBe('Validation failed')
      expect(form.fieldErrors.value.title).toBe('Title is required')

      const goodFd = new FormData()
      goodFd.set('title', 'Shipped')
      await form.submit(goodFd)
      expect(form.error.value).toBe('')
      expect(form.fieldErrors.value).toEqual({})
      expect(form.data.value).toEqual({ saved: 'Shipped' })
    }
    finally {
      globalThis.fetch = origFetch
    }
  })

  it('preserves event.submitter in FormData for multi-button forms (#3627)', async () => {
    GlobalRegistrator.register()
    try {
      const received: Record<string, FormDataEntryValue>[] = []
      const mockAction = Object.assign(
        async (input: FormData) => {
          received.push(Object.fromEntries(input.entries()))
          return { ok: true as const, data: 'saved' }
        },
        { url: '/_kay/action/save-1', toString: () => '/_kay/action/save-1' },
      )

      const formEl = document.createElement('form')
      formEl.innerHTML = `
        <input name="title" value="Post" />
        <button id="draft" type="submit" name="intent" value="draft">Draft</button>
        <button id="publish" type="submit" name="intent" value="publish">Publish</button>
      `
      document.body.appendChild(formEl)
      const draftBtn = formEl.querySelector('#draft') as HTMLButtonElement
      const publishBtn = formEl.querySelector('#publish') as HTMLButtonElement

      const form = useAction(mockAction)
      await form.onSubmit({
        preventDefault() {},
        currentTarget: formEl,
        submitter: publishBtn,
      } as unknown as SubmitEvent & { currentTarget: HTMLFormElement })
      await form.onSubmit({
        preventDefault() {},
        currentTarget: formEl,
        submitter: draftBtn,
      } as unknown as SubmitEvent & { currentTarget: HTMLFormElement })

      expect(received).toEqual([
        { title: 'Post', intent: 'publish' },
        { title: 'Post', intent: 'draft' },
      ])
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('batches multi-signal updates across submit, failure, success, and reset (#3627)', async () => {
    let resolveNext: ((res: ActionResult<{ ok: number }>) => void) | undefined
    const mockAction = Object.assign(
      () => new Promise<ActionResult<{ ok: number }>>((resolve) => { resolveNext = resolve }),
      { url: '/_kay/action/batch-1', toString: () => '/_kay/action/batch-1' },
    )

    const snapshots: Array<{ pending: boolean, error: string, fieldCount: number, data: { ok: number } | undefined }> = []
    let dispose: (() => void) | undefined
    const form = useAction(mockAction)
    root((stop) => {
      dispose = stop
      effect(() => {
        snapshots.push({
          pending: form.pending.value,
          error: form.error.value,
          fieldCount: Object.keys(form.fieldErrors.value).length,
          data: form.data.value,
        })
      })
    })

    try {
      expect(snapshots).toHaveLength(1)

      // 1. Start submit -> 1 atomic flush
      const p1 = form.submit(undefined as never)
      expect(snapshots).toHaveLength(2)
      expect(snapshots.at(-1)).toEqual({ pending: true, error: '', fieldCount: 0, data: undefined })

      // 2. Failure -> 1 atomic flush (error + fieldErrors + pending=false together)
      resolveNext!({ ok: false, status: 422, error: 'Bad', fieldErrors: { a: 'err' } })
      await p1
      expect(snapshots).toHaveLength(3)
      expect(snapshots.at(-1)).toEqual({ pending: false, error: 'Bad', fieldCount: 1, data: undefined })

      // 3. Re-submit -> 1 atomic flush (pending=true, error='', fieldErrors={})
      const p2 = form.submit(undefined as never)
      expect(snapshots).toHaveLength(4)
      expect(snapshots.at(-1)).toEqual({ pending: true, error: '', fieldCount: 0, data: undefined })

      // 4. Success -> 1 atomic flush (data + pending=false together)
      resolveNext!({ ok: true, data: { ok: 42 } })
      await p2
      expect(snapshots).toHaveLength(5)
      expect(snapshots.at(-1)).toEqual({ pending: false, error: '', fieldCount: 0, data: { ok: 42 } })

      // 5. reset() -> 1 atomic flush
      form.reset()
      expect(snapshots).toHaveLength(6)
      expect(snapshots.at(-1)).toEqual({ pending: false, error: '', fieldCount: 0, data: undefined })
    }
    finally {
      dispose?.()
    }
  })

  it('handles actionStub redirects without double-fetch/CORS failure and validates proxy JSON errors (#3627)', async () => {
    const dir = makeTemp('kay-action-redirect-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/actions'), { recursive: true })

    writeFileSync(join(dir, 'src/actions/nav.ts'), `
      import { action } from '@kayjs/kay/server'
      export const goDashboard = action(async (ctx) => {
        ctx.cookies.set('just_ran', 'yes', { httpOnly: true })
        return ctx.redirect('/dashboard', 303)
      })
      export const goStripe = action(async (ctx) => ctx.redirect('https://checkout.stripe.com/c/pay_123', 303))
    `)
    writeFileSync(join(dir, 'src/routes/dashboard.tsx'), `
      let renders = 0
      export function getRenders() { return renders }
      export default function Dashboard() {
        renders++
        return <h1>Dashboard</h1>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { goDashboard, goStripe } from '../actions/nav'
      export default function Home() {
        return <main><form action={goDashboard} method="post"><button>Go</button></form><form action={goStripe} method="post"><button>Pay</button></form></main>
      }
    `)

    const app = await testApp({ root: dir })
    const dashUrl = app.manifest!.actions.find(a => a.exportName === 'goDashboard')!.url
    const stripeUrl = app.manifest!.actions.find(a => a.exportName === 'goStripe')!.url
    const dashMod = await app.import('src/routes/dashboard.tsx') as { getRenders: () => number }

    const assigned: string[] = []
    const seenInits: RequestInit[] = []
    const origFetch = globalThis.fetch
    const origLocation = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: unknown }).location = { assign: (u: string) => assigned.push(u) }
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seenInits.push(init ?? {})
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      headers.set('origin', 'http://localhost')
      return app.fetch(new Request(`http://localhost${u}`, { ...init, headers }))
    }) as typeof fetch

    try {
      // 1. Same-origin redirect: uses redirect:'manual' + x-kay-action, navigates via x-kay-redirect, NEVER double-fetches /dashboard, preserves cookies
      const s1 = await Promise.race([actionStub(dashUrl)(undefined), Bun.sleep(20).then(() => 'pending')])
      expect(s1).toBe('pending')
      expect(seenInits[0]?.redirect).toBe('manual')
      expect(assigned).toEqual(['/dashboard'])
      expect(dashMod.getRenders()).toBe(0)
      expect(app.cookies.get('just_ran')).toBe('yes')

      // 2. Cross-origin redirect: returns 204 + x-kay-redirect instead of failing CORS inside fetch
      const s2 = await Promise.race([actionStub(stripeUrl)(undefined), Bun.sleep(20).then(() => 'pending')])
      expect(s2).toBe('pending')
      expect(assigned).toEqual(['/dashboard', 'https://checkout.stripe.com/c/pay_123'])

      // 3. Raw 302 Location header (manual redirect from non-Kay server) navigates without double-fetch
      globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: '/manual-target' } })) as unknown as typeof fetch
      const s3 = await Promise.race([actionStub('/_kay/action/raw')({}), Bun.sleep(20).then(() => 'pending')])
      expect(s3).toBe('pending')
      expect(assigned.at(-1)).toBe('/manual-target')

      // 4. Opaque redirect (e.g. proxy 302 in browser) settles as error instead of locking useAction pending=true
      const opaque = Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })
      globalThis.fetch = (async () => opaque) as unknown as typeof fetch
      const form = useAction(actionStub('/_kay/action/opaque'))
      const opaqueRes = await form.submit({})
      expect(opaqueRes).toEqual({ ok: false, status: 0, error: 'Unexpected redirect' })
      expect(form.pending.value).toBe(false)

      // 5. Proxy JSON errors (429 / 502 / malformed shapes) are normalized safely instead of blindly cast
      globalThis.fetch = (async () => Response.json({ message: 'Rate limit exceeded' }, { status: 429 })) as unknown as typeof fetch
      expect(await actionStub('/_kay/action/p')({})).toEqual({ ok: false, status: 429, error: 'Rate limit exceeded' })

      globalThis.fetch = (async () => Response.json({ code: 1015, upstream: 'down' }, { status: 502, statusText: 'Bad Gateway' })) as unknown as typeof fetch
      expect(await actionStub('/_kay/action/p')({})).toEqual({ ok: false, status: 502, error: 'Bad Gateway' })

      globalThis.fetch = (async () => new Response('null', { status: 503, statusText: '', headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
      expect(await actionStub('/_kay/action/p')({})).toEqual({ ok: false, status: 503, error: 'HTTP 503' })

      globalThis.fetch = (async () => Response.json({ ok: false, error: 123 }, { status: 500, statusText: '' })) as unknown as typeof fetch
      expect(await actionStub('/_kay/action/p')({})).toEqual({ ok: false, status: 500, error: 'HTTP 500' })
    }
    finally {
      globalThis.fetch = origFetch
      ;(globalThis as { location?: unknown }).location = origLocation
    }
  })
})
