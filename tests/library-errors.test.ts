import { describe, expect, it } from 'bun:test'
import { fixPath } from '../src/commands/fix-path'
import { explainError, KayError } from '../src/compiler/errors'
import { MarkdownError } from '../src/content/markdown'
import { IslandPropsError } from '../src/runtime/island.server'
import { PrivateAddressError } from '../src/server/address'
import { DatabaseOwnedError } from '../src/server/app-identity'
import { StreamRefusedError } from '../src/server/event-stream'
import { TimeoutError } from '../src/server/pg-poll'
import { GiveUpError } from '../src/server/queue'
import { RequestTimeoutError } from '../src/server/request-timeout'
import { RedirectRefusedError } from '../src/server/runtime-redirects'

describe('the runtime error classes', () => {
  const classes = [
    [PrivateAddressError, 'private-address'],
    [RedirectRefusedError, 'redirect-refused'],
    [GiveUpError, 'job-give-up'],
    [TimeoutError, 'poll-timeout'],
    [IslandPropsError, 'island-props-invalid'],
    [StreamRefusedError, 'stream-refused'],
    [DatabaseOwnedError, 'database-owned'],
  ] as const

  it('extend KayError with their code, a kind defaulting to it and their own name', () => {
    for (const [Class, code] of classes) {
      const error = new Class('x', { cause: 'why' })

      expect(error).toBeInstanceOf(KayError)
      expect(error).toBeInstanceOf(Class)
      expect(error.code).toBe(code)
      expect(error.kind).toBe(code)
      expect(error.name).toBe(Class.name)
      expect(error.status).toBeUndefined()
      expect(error.cause).toBe('why')
    }
  })

  it('keep the line of a MarkdownError and the status of a RequestTimeoutError', () => {
    const markdown = new MarkdownError('bad', 7)

    expect(markdown).toBeInstanceOf(KayError)
    expect([markdown.code, markdown.name, markdown.line]).toEqual(['markdown-invalid', 'MarkdownError', 7])

    const timeout = new RequestTimeoutError(50)

    expect([timeout.code, timeout.name, timeout.status, timeout.ms]).toEqual(['request-timeout', 'RequestTimeoutError', 504, 50])
  })

  it('explain a library code, with the fix in the library\'s folder or its installed package', () => {
    expect(explainError('ai-error')).toContain('packages/ai/llms/testing-and-errors.md')
    expect(explainError('ai-error', file => `at ${file}`)).toContain('at packages/ai/llms/testing-and-errors.md')
    expect(fixPath('packages/nope/llms/a.md')).toBe('node_modules/@kaynooo/kayjs-nope/llms/a.md')
    expect(fixPath('llms/errors.md')).toBe('llms/errors.md')
  })
})
