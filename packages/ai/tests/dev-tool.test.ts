import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ai, AiError, ask, fakeAi } from '../src'
import { forgetAsks } from '../src/dev-log'
import { forgetCounts } from '../src/limits'

const devCode = process.env.KAY_DEV_CODE

beforeEach(() => {
  forgetAsks()
  forgetCounts()
})

afterEach(() => {
  if (devCode === undefined)
    delete process.env.KAY_DEV_CODE
  else
    process.env.KAY_DEV_CODE = devCode

  ai()
  fakeAi.clear()
})

// The error an ask ends with, a reply being a thenable and not a promise.
async function failure(reply: PromiseLike<unknown>): Promise<Error> {
  try {
    await reply
  }
  catch (error) {
    return error as Error
  }

  throw new Error('the ask did not fail')
}

async function read(extension = ai()): Promise<Response> {
  const plugin = await (extension.server as () => { handle: (request: Request) => Promise<Response> })()

  return plugin.handle(new Request('http://localhost/_kay/ai'))
}

describe('the dev tool\'s AI tab', () => {
  it('names its browser module in the extension', () => {
    expect(ai().devTool).toEqual({ module: expect.stringMatching(/devTool\.ts$/) })
  })

  it('lists the asks newest first with their tokens and outcome, and the limit in effect, under kay dev', async () => {
    process.env.KAY_DEV_CODE = '0'
    const extension = ai({ limit: { max: 2, window: '10m' }, budget: { tokens: 1000, total: 5000, window: '1d' } })

    fakeAi.reply('first')
    await ask('Hello there', { visitor: 'v' })
    fakeAi.reply('second')
    await ask('Another one', { visitor: 'v' })

    await expect(await failure(ask('Third', { visitor: 'v' }))).toBeInstanceOf(AiError)

    const response = await read(extension)
    const body = await response.json() as { provider: string, limit: unknown, budget: unknown, asks: { prompt: string, outcome: string, tokens: number }[] }

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.provider).toBe(fakeAi.name)
    expect(body.limit).toEqual({ max: 2, seconds: 600 })
    expect(body.budget).toEqual({ tokens: 1000, total: 5000, seconds: 86_400 })
    expect(body.asks.map(item => [item.prompt, item.outcome])).toEqual([['Third', 'refused'], ['Another one', 'ok'], ['Hello there', 'ok']])
    expect(body.asks[1]!.tokens).toBeGreaterThan(0)
    expect(body.asks[0]!.tokens).toBe(0)
  })

  it('keeps a failed ask with its message', async () => {
    process.env.KAY_DEV_CODE = '0'
    fakeAi.fail(new Error('boom'))
    await expect((await failure(ask('Break'))).message).toContain('boom')

    const { asks } = await (await read()).json() as { asks: { outcome: string, error?: string }[] }

    expect(asks).toMatchObject([{ outcome: 'failed', error: expect.stringContaining('boom') }])
  })

  it('keeps the last 50 asks only', async () => {
    process.env.KAY_DEV_CODE = '0'

    for (let index = 0; index < 55; index++)
      await ask(`Ask ${index}`)

    const { asks } = await (await read()).json() as { asks: { prompt: string }[] }

    expect(asks).toHaveLength(50)
    expect(asks[0]!.prompt).toBe('Ask 54')
  })

  it('records nothing and answers 404 outside kay dev', async () => {
    delete process.env.KAY_DEV_CODE
    await ask('Quiet')
    expect((await read()).status).toBe(404)
  })
})
