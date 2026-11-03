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
  it('reads data where an instanceof narrows the receiver, and reports a catch or a cast with no fix', async () => {
    const narrowed = 'import { ApiError } from \'kay\'\n\nexport const a = (error: unknown) => error instanceof ApiError ? error.answer : undefined\n'
    const caught = 'import { ApiError } from \'kay\'\n\nexport async function b(run: () => Promise<void>) {\n  try {\n    await run()\n  }\n  catch (error) {\n    return (error as ApiError).answer ?? error\n  }\n}\n'
    const root = await project({ 'src/narrowed.ts': narrowed, 'src/caught.ts': caught })

    try {
      const found = await apiErrorAnswers(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes === undefined]).sort()).toEqual([['src/caught.ts', true], ['src/narrowed.ts', false]])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/narrowed.ts')).toBe(narrowed.replace('.answer', '.data'))
      expect(await read(root, 'src/caught.ts')).toBe(caught)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not trust a check made in another function, and leaves files without the classes alone', async () => {
    const other = 'import { ApiError } from \'kay\'\n\nexport const a = (error: unknown) => {\n  if (!(error instanceof ApiError))\n    return undefined\n\n  return [1].map(() => (error as { answer?: unknown }).answer)\n}\n'
    const unrelated = 'export const b = (reply: { answer: string }) => reply.answer\n'
    const fence = '--- server\nconst show = (error: unknown) => error instanceof ApiError ? error.answer : undefined\n---\np x\n'
    const root = await project({ 'src/other.ts': other, 'src/unrelated.ts': unrelated, 'src/routes/index.kay': fence })

    try {
      const found = await apiErrorAnswers(root, {})

      expect(found.map(diagnostic => diagnostic.file.slice(root.length + 1))).toEqual(['src/routes/index.kay'])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/routes/index.kay')).toBe(fence.replace('.answer', '.data'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
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
