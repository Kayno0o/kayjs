import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/form-ambient', islands: false })
const { add } = await import(join(import.meta.dir, 'fixtures/form-ambient/src/routes/index.kay')) as { add: Parameters<typeof site.submit>[0] }

describe('an error and a pending line outside every form of their file', () => {
  it('follow the form a snippet and a component render in, with the message of a refused post, and none outside a form', async () => {
    const refused = await site.submit(add, { title: 'ab' }, { from: '/' })

    expect(refused.status).toBe(422)
    expect(refused.html.match(/<p class="error"[^>]*>Too short<\/p>/g)).toHaveLength(2)
    expect(refused.html.slice(refused.html.indexOf('class="outside"'))).not.toContain('Too short')
  })

  it('render the pending block hidden, and no message before a post', async () => {
    const { html } = await site.visit('/')

    expect(html).not.toContain('Too short')
    expect(html.match(/<slot data-kay-pending hidden>/g)).toHaveLength(3)
  })
})

describe('the same lines in an island', () => {
  it('read the form they render in as the component is created', () => {
    const { tsx } = compileKay('---\n---\ndiv\n  error title\n  pending\n    p Saving\n', join(process.cwd(), 'row.kay'), { output: 'dom', hydratable: true })

    expect(tsx).toContain('KayFormHere()')
    expect(tsx).toContain('KayPendingCall(')
    expect(tsx).toMatch(/import \{[^}]*formHere as KayFormHere[^}]*\} from 'kay\/internal'/)
    expect(tsx).toMatch(/import \{[^}]*formError as KayFormError[^}]*\} from 'kay\/internal'/)
  })

  it('import what they read when a component given an action is the form around them', () => {
    const { tsx } = compileKay('---\nimport Form from \'./form.kay\'\nimport { add } from \'./add\'\n---\nForm(action={add})\n  error title\n  pending\n    p Saving\n', join(process.cwd(), 'row.kay'), { output: 'dom', hydratable: true })

    expect(tsx).toMatch(/import \{[^}]*formHere as KayFormHere[^}]*\} from 'kay\/internal'/)
    expect(tsx).toMatch(/import \{[^}]*formError as KayFormError[^}]*\} from 'kay\/internal'/)
  })
})
