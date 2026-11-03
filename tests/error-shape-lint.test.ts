import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { apiErrorAnswers, refusalMessages } from '../src/check/error-shape'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('error-shape-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()

describe('deprecated-api-error-answer', () => {
  const head = 'import { ActionError, ApiError } from \'kay\'\n\n'
  const found = async (files: Record<string, string>) => {
    const root = await project(files)

    try {
      const diagnostics = await apiErrorAnswers(root, {})

      await applySafeFixes(root, diagnostics)

      return { diagnostics: diagnostics.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes?.[0]?.safe, diagnostic.fixes?.[0]?.edits[0]?.text]), after: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await read(root, path)]))) as Record<string, string> }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('fixes an ActionError read to body as a safe fix', async () => {
    const source = `${head}export const a = (error: unknown) => error instanceof ActionError ? error.answer : undefined\n`
    const { diagnostics, after } = await found({ 'src/a.ts': source })

    expect(diagnostics).toEqual([['src/a.ts', true, 'body']])
    expect(after['src/a.ts']).toBe(source.replace('.answer', '.body'))
  })

  it('offers data for an ApiError read, never as a safe fix, since it may be an ActionError', async () => {
    const source = `${head}export const a = (error: unknown) => error instanceof ApiError && error.status > 0 ? error.answer : undefined\n`
    const { diagnostics, after } = await found({ 'src/a.ts': source })

    expect(diagnostics).toEqual([['src/a.ts', false, 'data']])
    expect(after['src/a.ts']).toBe(source)
  })

  it('counts a narrowing only inside the consequent of the test, not the alternate, a negation or an unrelated branch', async () => {
    const source = head + [
      'export function a(error: unknown, other: { answer: string }) {',
      '  if (!(error instanceof ActionError))',
      '    return (error as ApiError).answer',
      '',
      '  if (error instanceof ApiError)',
      '    return other.answer',
      '',
      '  return error instanceof ActionError ? 1 : error.answer',
      '}',
      '',
    ].join('\n')
    const { diagnostics, after } = await found({ 'src/a.ts': source })

    expect(diagnostics).toEqual([['src/a.ts', undefined, undefined]])
    expect(after['src/a.ts']).toBe(source)
  })

  it('drops the narrowing of a receiver the consequent assigns again', async () => {
    const source = `${head}export function a(error: unknown, other: unknown) {\n  if (error instanceof ActionError) {\n    error = other\n    return error.answer\n  }\n}\n`
    const { diagnostics, after } = await found({ 'src/a.ts': source })

    expect(diagnostics).toEqual([])
    expect(after['src/a.ts']).toBe(source)
  })

  it('reports a catch or a cast with no fix, a function made inside a narrowing without its narrowing, and leaves other files alone', async () => {
    const caught = `${head}export async function b(run: () => Promise<void>) {\n  try {\n    await run()\n  }\n  catch (error) {\n    return (error as ApiError).answer ?? error\n  }\n}\n`
    const nested = `${head}export const c = (error: unknown) => error instanceof ActionError ? [1].map(() => (error as { answer?: unknown }).answer) : 0\n`
    const unrelated = 'export const d = (reply: { answer: string }) => reply.answer\n'
    const fence = '--- server\nconst show = (error: unknown) => error instanceof ActionError ? error.answer : undefined\n---\np x\n'
    const { diagnostics, after } = await found({ 'src/caught.ts': caught, 'src/nested.ts': nested, 'src/unrelated.ts': unrelated, 'src/routes/index.kay': fence })

    expect(diagnostics.toSorted()).toEqual([['src/caught.ts', undefined, undefined], ['src/routes/index.kay', true, 'body']])
    expect(after['src/routes/index.kay']).toBe(fence.replace('.answer', '.body'))
    expect(after['src/caught.ts']).toBe(caught)
  })
})

describe('deprecated-refusal-message', () => {
  it('offers the instanceof form, never as a safe fix', async () => {
    const source = 'import { ApiError, refusalMessage } from \'kay\'\n\nexport const a = (error: unknown) => refusalMessage(error, \'Try again\')\nexport const b = (error: unknown) => ({ text: refusalMessage(error, \'No\') }) satisfies unknown\nexport const c = (error: unknown) => `${refusalMessage(error, \'No\')}!` + refusalMessage(error, \'x\')\n'
    const root = await project({ 'src/messages.ts': source })

    try {
      const found = await refusalMessages(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(diagnostic => diagnostic.fixes?.[0]?.safe === false)).toBe(true)

      const edits = found[0]!.fixes![0]!.edits.map(edit => edit.text)

      expect(edits).toContain('error instanceof ApiError && error.status !== 0 ? error.message : \'Try again\'')
      await applySafeFixes(root, found)
      expect(await read(root, 'src/messages.ts')).toBe(source)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not use a type-only ApiError import as a value', async () => {
    const source = 'import { type ApiError, refusalMessage } from \'kay\'\n\nexport const a = (error: unknown): ApiError | string => refusalMessage(error, \'x\')\n'
    const root = await project({ 'src/a.ts': source })

    try {
      expect((await refusalMessages(root, {})).map(diagnostic => diagnostic.fixes)).toEqual([undefined])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a first argument that is no plain name, a value read, and another refusalMessage', async () => {
    const module = 'import { refusalMessage } from \'kay\'\n\nexport const a = (errors: unknown[]) => refusalMessage(errors[0], \'x\')\nexport const b = [1].map(refusalMessage)\n'
    const own = 'import { refusalMessage } from \'./mine\'\n\nexport const c = refusalMessage(1, \'y\')\n'
    const root = await project({ 'src/a.ts': module, 'src/own.ts': own })

    try {
      const found = await refusalMessages(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes]).sort()).toEqual([['src/a.ts', undefined]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
