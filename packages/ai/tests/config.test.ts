import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ai } from '../src'
import { choose } from '../src/config'

const NAMES = ['NODE_ENV', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_PROVIDER']
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

beforeEach(() => {
  for (const name of NAMES)
    delete process.env[name]
})

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined)
      delete process.env[name]
    else
      process.env[name] = saved[name]
  }
})

function configure(env: Record<string, string>) {
  Object.assign(process.env, env)

  return choose()
}

describe('the provider the environment names', () => {
  it('is the fake under bun test, whatever keys are set', () => {
    expect(configure({ NODE_ENV: 'test', ANTHROPIC_API_KEY: 'k', AI_BASE_URL: 'http://x' }).provider.name).toBe('fake')
  })

  it('is the fake in development until something is configured', () => {
    expect(configure({ NODE_ENV: 'development' }).provider.name).toBe('fake')
    expect(choose().provider.name).toBe('fake')
    process.env.OPENAI_API_KEY = 'k'
    expect(choose().provider.name).toBe('openai')
  })

  it('is Anthropic for its key, OpenAI for its own, and an OpenAI-compatible server for a base URL', () => {
    expect(configure({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-x' })).toMatchObject({ provider: { name: 'anthropic' }, model: 'claude-x' })
    delete process.env.ANTHROPIC_API_KEY
    expect(configure({ OPENAI_API_KEY: 'k' }).provider.name).toBe('openai')
    expect(configure({ AI_BASE_URL: 'http://localhost:11434/v1' }).provider.name).toBe('openai')
  })

  it('wants AI_PROVIDER to choose between two keys, and honours it', () => {
    expect(() => configure({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toThrow('AI_PROVIDER')
    expect(configure({ AI_PROVIDER: 'anthropic' }).provider.name).toBe('anthropic')
    expect(configure({ AI_PROVIDER: 'openai' }).provider.name).toBe('openai')
    expect(() => configure({ AI_PROVIDER: 'nonsense' })).toThrow('AI_PROVIDER')
  })

  it('stops a production server with nothing configured, naming the variables', () => {
    expect(() => configure({ NODE_ENV: 'production' })).toThrow('ANTHROPIC_API_KEY, OPENAI_API_KEY, or AI_BASE_URL')
  })

  it('stops AI_PROVIDER=anthropic without its key', () => {
    expect(() => configure({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'o' })).toThrow('ANTHROPIC_API_KEY is not set')
  })
})

describe('the extension', () => {
  it('lists the variables for kay env, the model required in production', () => {
    const { env } = ai()

    expect(Object.keys(env!.properties)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_PROVIDER'])
    expect(env!.properties.AI_MODEL).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.ANTHROPIC_API_KEY).not.toMatchObject({ requiredInProduction: true })
  })
})
