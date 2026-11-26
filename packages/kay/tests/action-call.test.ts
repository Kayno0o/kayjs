import type { ServerAction } from '../src/server/index'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-action-call-'))
  tempDirs.push(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

const notes = `
  import { action } from '@kayjs/kay/server'
  const titled = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => typeof (value as { title?: unknown })?.title === 'string' ? { value: value as { title: string } } : { issues: [{ message: 'Title is required', path: ['title'] }] } } }
  export const addNote = action(titled, async (input, ctx) => \`\${input.title} by \${ctx.locals.who ?? 'nobody'}\`)
  export const addTwo = action(titled, async (input) => {
    const first = await addNote(input)
    const second = await addNote({ title: \`\${input.title} again\` })
    return [first, second]
  })
`

describe('a server action called from server code (#3580)', () => {
  it('runs its schema and folder middleware from a route, load(), middleware and another action', async () => {
    const dir = appWith({
      'src/routes/notes/_middleware.ts': `
        import type { Middleware } from '@kayjs/kay/server'
        const who: Middleware = (ctx, next) => { ctx.locals.who = 'alice'; return next() }
        export default who
      `,
      'src/routes/notes/actions.ts': notes,
      'src/routes/api/add.ts': `
        import type { RequestContext } from '@kayjs/kay/server'
        import { addNote, addTwo } from '../notes/actions'
        export async function GET(ctx: RequestContext) {
          return ctx.json({ valid: await addNote({ title: 'Hi' }), invalid: await addNote({} as never), nested: await addTwo({ title: 'Yo' }) })
        }
      `,
      'src/routes/loaded.tsx': `
        import type { RequestContext } from '@kayjs/kay/server'
        import { addNote } from './notes/actions'
        export async function load(ctx: RequestContext) { return addNote({ title: 'From load' }) }
        export default function Loaded({ data }: { data: { ok: boolean, data?: string } }) { return <p>{data.data}</p> }
      `,
      'src/routes/guarded/_middleware.ts': `
        import type { Middleware } from '@kayjs/kay/server'
        import { addNote } from '../notes/actions'
        const check: Middleware = async (ctx, next) => { const res = await addNote({ title: 'From middleware' }); return res.ok ? ctx.text(res.data) : next() }
        export default check
      `,
      'src/routes/guarded/index.ts': 'export function GET(): Response { return new Response(\'unreached\') }\n',
    })
    const app = await testApp({ root: dir })
    try {
      expect(await (await app.get('/api/add')).json()).toEqual({
        valid: { ok: true, data: 'Hi by alice' },
        invalid: { ok: false, status: 400, error: 'Validation failed', fieldErrors: { title: 'Title is required' }, issues: [{ message: 'Title is required', path: ['title'] }] },
        nested: { ok: true, data: [{ ok: true, data: 'Yo by alice' }, { ok: true, data: 'Yo again by alice' }] },
      })
      expect(await (await app.get('/loaded')).text()).toContain('<p>From load by alice</p>')
      expect(await (await app.get('/guarded')).text()).toBe('From middleware by alice')
      const mod = await app.import('src/routes/notes/actions.ts') as { addTwo: ServerAction<{ title: string }, string[]> }
      expect(await (await app.submit(mod.addTwo, { title: 'Posted' })).json()).toEqual({ ok: true, data: [{ ok: true, data: 'Posted by alice' }, { ok: true, data: 'Posted again by alice' }] })
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('names the action and where to call it from when called outside a request', async () => {
    const dir = appWith({ 'src/routes/notes/actions.ts': notes, 'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n' })
    const app = await testApp({ root: dir })
    try {
      const mod = await app.import('src/routes/notes/actions.ts') as { addNote: ServerAction<{ title: string }, string> }
      await expect(mod.addNote({ title: 'Hi' })).rejects.toThrow('kay: addNote was called outside a request; call it from a route, load(), middleware or another action, or with app.submit in a test.')
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('preserves ctx.deny() status, error, and fieldErrors on programmatic server calls (#3627)', async () => {
    const dir = appWith({
      'src/routes/actions.ts': `
        import { action } from '@kayjs/kay/server'
        export const reject = action(async (ctx) => ctx.deny(422, 'Already exists', { email: 'Taken' }))
      `,
      'src/routes/api/check.ts': `
        import type { RequestContext } from '@kayjs/kay/server'
        import { reject } from '../actions'
        export async function GET(ctx: RequestContext) { return ctx.json(await reject()) }
      `,
      'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n',
    })
    const app = await testApp({ root: dir })
    try {
      expect(await (await app.get('/api/check')).json()).toEqual({
        ok: false,
        status: 422,
        error: 'Already exists',
        fieldErrors: { email: 'Taken' },
      })
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('enters request action scope during fastStaticPages render (with and without load) and on 404 pages (#3626)', async () => {
    const dir = appWith({
      'src/routes/actions.ts': `
        import { action } from '@kayjs/kay/server'
        export const greet = action(async (ctx) => \`hello:\${ctx.url.pathname}\`)
      `,
      'src/routes/no-load.tsx': `
        import { greet } from './actions'
        export default async function NoLoad() {
          const res = await greet()
          return <p>{res.ok ? res.data : res.error}</p>
        }
      `,
      'src/routes/with-load.tsx': `
        import { greet } from './actions'
        export async function load() { return { tag: 'after-load' } }
        export default async function WithLoad({ data }: { data: { tag: string } }) {
          const res = await greet()
          return <p>{data.tag}:{res.ok ? res.data : res.error}</p>
        }
      `,
      'src/routes/missing-load.tsx': `
        import { notFound } from '@kayjs/kay/server'
        export async function load() { return notFound() }
        export default function MissingLoad() { return <p>never</p> }
      `,
      'src/routes/_404.tsx': `
        import { greet } from './actions'
        export default async function NotFound() {
          const res = await greet()
          return <p>404:{res.ok ? res.data : res.error}</p>
        }
      `,
    })
    const app = await testApp({ root: dir })
    try {
      const noLoadRes = await app.get('/no-load')
      expect(noLoadRes.status).toBe(200)
      expect(await noLoadRes.text()).toContain('<p>hello:/no-load</p>')

      const withLoadRes = await app.get('/with-load')
      expect(withLoadRes.status).toBe(200)
      expect(await withLoadRes.text()).toContain('<p>after-load:hello:/with-load</p>')

      const missingLoadRes = await app.get('/missing-load')
      expect(missingLoadRes.status).toBe(404)
      expect(await missingLoadRes.text()).toContain('<p>404:hello:/missing-load</p>')

      const notFoundRes = await app.get('/does-not-exist')
      expect(notFoundRes.status).toBe(404)
      expect(await notFoundRes.text()).toContain('<p>404:hello:/does-not-exist</p>')
    }
    finally {
      await app.app.dispose?.()
    }
  })
})
