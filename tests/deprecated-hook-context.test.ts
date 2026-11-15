import type { CheckDiagnostic, CheckOptions } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { hookContext } from '../src/check/hook-context'
import { scratchDir } from './scratch'

const check: (root: string, options: CheckOptions) => Promise<CheckDiagnostic[]> = hookContext

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: CheckDiagnostic[] }> {
  const root = await scratchDir('hook-context-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await check(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-hook-context', () => {
  it('reads context where an action hook of the config read ctx', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { actions: { onSuccess: ({ action, ctx }) => audit(action, ctx.locals), onError: event => log(event.ctx.locale), beforeRun: ({ ctx: run }) => run.request } }\n',
    })

    expect(found).toHaveLength(3)
    expect(text['kay.config.ts']).toBe('export default { actions: { onSuccess: ({ action, context: ctx }) => audit(action, ctx.locals), onError: event => log(event.context.locale), beforeRun: ({ context: run }) => run.request } }\n')
  })

  it('finds the hooks in the options of an action call', async () => {
    const { found, text } = await fixed({
      'src/routes/x.ts': 'import { action } from \'kay\'\n\nexport const save = action(async () => 1, { onSuccess: ({ ctx }) => ctx.status(200) })\n',
    })

    expect(found).toHaveLength(1)
    expect(text['src/routes/x.ts']).toContain('{ context: ctx }')
  })

  it('reports a name given a default with no fix, and leaves other ctx alone', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { actions: { onSuccess: ({ ctx = null }) => ctx, onError: ({ action }) => action, beforeRun: () => 1 } }\n',
      'src/routes/x.ts': 'export const x = { onSuccess: ({ ctx }) => ctx }\nexport function other(ctx) { return ctx.locals }\n',
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.fixes).toBeUndefined()
    expect(text['src/routes/x.ts']).toContain('{ ctx }')
  })
})
