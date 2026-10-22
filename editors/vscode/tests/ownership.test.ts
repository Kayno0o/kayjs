import { describe, expect, it } from 'bun:test'
import { ownedBy } from '../src/ownership'

const doc = (path: string) => ({ uri: { fsPath: path } })
const served = ['/repo', '/repo/docs']

// A hook of the middleware, as the client calls it.
type Hook = (...args: unknown[]) => unknown
const hook = (root: string, name: string, roots = served): Hook => (ownedBy(root, () => roots) as unknown as Record<string, Hook>)[name]!

describe('ownedBy', () => {
  it('passes the notifications of a file it owns on, and drops the others as a promise the client can chain on', async () => {
    const seen: unknown[] = []
    const next = async (document: unknown) => {
      seen.push(document)
    }

    for (const name of ['didOpen', 'didClose', 'didSave']) {
      const mine = doc('/repo/src/a.kay')
      const nested = doc('/repo/docs/b.kay')

      await hook('/repo', name)(mine, next)
      expect(hook('/repo', name)(nested, next)).toBeInstanceOf(Promise)
      await hook('/repo', name)(nested, next)
      expect(seen).toEqual([mine])
      seen.length = 0
    }
  })

  it('reads the served roots at each call, so a nested root served later takes its files', async () => {
    const roots = ['/repo']
    const seen: unknown[] = []
    const open = hook('/repo', 'didOpen', roots)

    await open(doc('/repo/docs/b.kay'), async (document: unknown) => {
      seen.push(document)
    })
    roots.push('/repo/docs')
    await open(doc('/repo/docs/c.kay'), async (document: unknown) => {
      seen.push(document)
    })
    expect(seen).toHaveLength(1)
  })

  it('answers a promise to the hooks that take an event, an empty list for willSaveWaitUntil', async () => {
    const event = { document: doc('/repo/docs/b.kay') }

    expect(await hook('/repo', 'didChange')(event, async () => 'sent')).toBeUndefined()
    expect(await hook('/repo', 'willSave')(event, async () => 'sent')).toBeUndefined()
    expect(await hook('/repo', 'willSaveWaitUntil')(event, async () => ['edit'])).toEqual([])
    expect(await hook('/repo/docs', 'willSaveWaitUntil')(event, async () => ['edit'])).toEqual(['edit'])
  })

  it('drops the diagnostics of a nested file and the language features asked about one', () => {
    const sent: unknown[] = []

    hook('/repo', 'handleDiagnostics')(doc('/repo/docs/b.kay').uri, [], (...args: unknown[]) => sent.push(args))
    expect(sent).toEqual([])
    hook('/repo/docs', 'handleDiagnostics')(doc('/repo/docs/b.kay').uri, [], (...args: unknown[]) => sent.push(args))
    expect(sent).toHaveLength(1)
    expect(hook('/repo', 'provideHover')(doc('/repo/docs/b.kay'), 'position', 'token', () => 'hover')).toBeUndefined()
    expect(hook('/repo', 'provideHover')(doc('/repo/src/a.kay'), 'position', 'token', () => 'hover')).toBe('hover')
  })

  it('leaves every other hook to the client', () => {
    const middleware = ownedBy('/repo', () => served) as unknown as Record<string, unknown>

    expect(middleware.workspace).toBeUndefined()
    expect(middleware.constructor).toBeUndefined()
  })
})
