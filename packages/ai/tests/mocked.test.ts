import type { NoInputAction, s, ServerAction } from 'kay'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { actionTool } from 'kay/library'
import { testSite } from 'kay/test'
import { ai, ask, fakeAi, mocked } from '../src'
import { forgetCounts } from '../src/limits'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })
const routes = await import(join(import.meta.dir, 'fixture/src/routes/tools.kay')) as { addNote: ServerAction<ReturnType<typeof s.Object<{ title: ReturnType<typeof s.String> }>>, unknown>, homeState: NoInputAction<string>, vetoed: NoInputAction<string>, upload: ServerAction<ReturnType<typeof s.Object<{ photo: ReturnType<typeof s.File> }>>, unknown> }
const { addNote } = routes

afterAll(async () => site.close())
afterEach(() => {
  ai()
  forgetCounts()
  fakeAi.clear()
})

describe('mocked', () => {
  it('offers an action with its own name, description, label and input schema, answered by the mock', async () => {
    const seen: string[] = []
    const home = mocked(routes.homeState, () => {
      seen.push('home')

      return { lit: true }
    })
    const noted = mocked(addNote, ({ title }) => {
      seen.push(title)

      return { id: 7 }
    })

    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }, { name: 'home_state', input: {} }] })
    fakeAi.reply('done')

    const reply = ask('add milk', { tools: [home, noted] })

    expect(await reply).toBe('done')
    expect(seen).toEqual(['Milk', 'home'])
    expect((await reply.calls).map(call => [call.name, call.status, call.result, call.label])).toEqual([['add_note', 'done', '{"id":7}', undefined], ['home_state', 'done', '{"lit":true}', 'Read the home']])

    const offered = fakeAi.asked[0]!.tools!
    const real = actionTool(addNote as never)!
    const spec = offered.find(item => item.name === 'add_note')!

    expect(spec.description).toBe(real.description)
    expect(spec.inputSchema).toEqual(real.inputSchema)
    expect(offered.find(item => item.name === 'home_state')!.description).toBe('Reads the home')
  })

  it('refuses the arguments the action\'s schema refuses, without running the mock', async () => {
    let ran = false
    const noted = mocked(addNote, () => {
      ran = true

      return 'x'
    })

    fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 1 } }] })
    fakeAi.reply('ok')

    const reply = ask('add', { tools: [noted] })

    await reply

    expect(ran).toBe(false)
    expect((await reply.calls)[0]!.status).toBe('failed')
  })

  it('refuses an action that cannot be a tool', () => {
    expect(() => mocked(routes.vetoed, () => '')).toThrow('mocked takes an action')
    expect(() => mocked(routes.upload, () => '')).toThrow('mocked takes an action')
  })
})
