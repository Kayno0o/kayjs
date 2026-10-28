import type { AiError } from '../src'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { embed, openai } from '../src'
import { aiTest } from '../src/test'

const model = aiTest()

const received: Record<string, unknown>[] = []
let answer: (body: Record<string, unknown>) => Response = () => new Response(null, { status: 500 })

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as Record<string, unknown>

    received.push({ path: new URL(request.url).pathname, ...body })

    return answer(body)
  },
})

const ollama = openai({ baseUrl: `http://localhost:${server.port}/v1` })

afterEach(() => {
  received.length = 0
})

afterAll(async () => server.stop(true))

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0)
}

async function failure(call: Promise<unknown>): Promise<AiError> {
  try {
    await call
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the call did not fail')
}

describe('embed under bun test', () => {
  it('gives each text a stable unit vector, texts sharing words nearer than others', async () => {
    const [cats, cats2, kittens, taxes] = await embed(['The cat sat on the mat', 'the CAT sat on the mat', 'A cat on a mat, sleeping', 'Quarterly tax filing deadlines'])

    expect(cats).toHaveLength(256)
    expect(cats2).toEqual(cats)
    expect(Math.hypot(...cats!)).toBeCloseTo(1)
    expect(cosine(cats!, kittens!)).toBeGreaterThan(cosine(cats!, taxes!))
    expect(await embed('The cat sat on the mat')).toEqual(cats!)
  })

  it('makes vectors of the dimensions asked, keeping what it was given', async () => {
    expect(await embed('Hi', { dimensions: 768 })).toHaveLength(768)
    expect(model.embedded[0]).toEqual({ provider: 'fake', model: 'fake', input: ['Hi'], dimensions: 768 })
  })

  it('answers a script, and an empty list with no call', async () => {
    model.embedding([[1, 0], [0, 1]])

    expect(await embed(['a', 'b'])).toEqual([[1, 0], [0, 1]])
    expect(await embed([])).toEqual([])
    expect(model.embedded).toHaveLength(1)
  })

  it('refuses dimensions that are no whole number of 1 or more', async () => {
    await expect(embed('Hi', { dimensions: 1.5 })).rejects.toThrow('whole number')
  })
})

describe('embed at an OpenAI-compatible server', () => {
  it('posts the texts to /embeddings and gives the vectors back in their order', async () => {
    answer = () => Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })

    expect(await embed(['first', 'second'], { provider: ollama, model: 'nomic-embed-text', dimensions: 2 })).toEqual([[1, 0], [0, 1]])
    expect(received[0]).toEqual({ path: '/v1/embeddings', model: 'nomic-embed-text', input: ['first', 'second'], dimensions: 2 })
  })

  it('sends no dimensions unless asked, and one text gives one vector', async () => {
    answer = () => Response.json({ data: [{ index: 0, embedding: [0.5, 0.5, 0.5] }] })

    expect(await embed('only', { provider: ollama, model: 'nomic-embed-text' })).toEqual([0.5, 0.5, 0.5])
    expect(received[0]).not.toHaveProperty('dimensions')
  })

  it('fails when a vector is not of the dimensions asked, as a vector column would refuse it', async () => {
    answer = () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] })

    const error = await failure(embed('only', { provider: ollama, model: 'all-minilm', dimensions: 2 }))

    expect(error.kind).toBe('protocol')
    expect(error.message).toContain('3 numbers, not the 2 asked')
  })

  it('fails when the server answers another count of vectors or no numbers', async () => {
    answer = () => Response.json({ data: [{ index: 0, embedding: [1] }] })

    expect((await failure(embed(['a', 'b'], { provider: ollama, model: 'm' }))).message).toContain('1 vectors for 2 texts')

    answer = () => Response.json({ data: [{ index: 0, embedding: 'AAAA' }] })

    expect((await failure(embed('a', { provider: ollama, model: 'm' }))).kind).toBe('protocol')
  })

  it('surfaces the server\'s refusal', async () => {
    answer = () => Response.json({ error: { message: 'model "nope" not found' } }, { status: 404 })

    const error = await failure(embed('a', { provider: ollama, model: 'nope' }))

    expect(error.kind).toBe('invalid')
    expect(error.message).toContain('not found')
  })
})
