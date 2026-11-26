import type { ActionResult } from '@kayjs/kay/server'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useAction } from '@kayjs/kay'
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
})
