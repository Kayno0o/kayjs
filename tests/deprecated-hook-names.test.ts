import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { hookNames } from '../src/check/hook-names'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('hook-names-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-hook-names', () => {
  it('renames the observing hooks of each library, in a call, a collection, a list and the auth hooks file', async () => {
    const config = [
      'import { auth } from \'@kayjs/auth\'',
      'import { cms } from \'@kayjs/cms\'',
      'import { ai } from \'@kayjs/ai\'',
      'import { mail } from \'@kayjs/mail\'',
      '',
      'export default { extensions: [',
      '  auth({ onSignUp: ({ user }) => user, onEvent: log }),',
      '  cms({ onSave, onUpload: purge, collections: { posts: { onSave: own } } }),',
      '  ai({ onStep: a, onToolCall: b, onSuccess: c, onError: d }),',
      '  mail({ onSend: e, onSuppress: f }),',
      '] }',
      '',
    ].join('\n')

    const lists = 'import { mailer } from \'@kayjs/mail\'\nexport const l = mailer({ from: \'a@b.c\' }).list(\'news\', { onSubscribe: a, onBroadcast })\n'
    const hooks = 'export const hooks = { onSignUp: ({ user }) => user }\n'
    const root = await project({ 'kay.config.ts': config, 'src/lists.ts': lists, 'src/auth.ts': hooks, 'src/other.ts': 'export const x = { onSave: 1 }\n' })
    const found = await hookNames(root, {})

    expect(found).toHaveLength(12)
    expect(found.every(one => one.code === 'deprecated-hook-names' && one.fixes?.[0]?.safe === true)).toBe(true)
    await applySafeFixes(root, found)

    const fixed = await Bun.file(join(root, 'kay.config.ts')).text()

    expect(fixed).toContain('auth({ afterSignUp: ({ user }) => user, onEvent: log })')
    expect(fixed).toContain('cms({ afterSave: onSave, afterUpload: purge, collections: { posts: { afterSave: own } } })')
    expect(fixed).toContain('ai({ afterStep: a, afterToolCall: b, afterRequest: c, onError: d })')
    expect(fixed).toContain('mail({ afterSend: e, afterSuppress: f })')
    expect(await Bun.file(join(root, 'src/lists.ts')).text()).toContain('{ afterSubscribe: a, afterBroadcast: onBroadcast }')
    expect(await Bun.file(join(root, 'src/auth.ts')).text()).toBe('export const hooks = { afterSignUp: ({ user }) => user }\n')
    expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe('export const x = { onSave: 1 }\n')
  })

  it('reports with no fix an object that spreads another or writes the new name', async () => {
    const source = 'import { cms } from \'@kayjs/cms\'\nexport const a = cms({ ...base, onSave: x })\nexport const b = cms({ onSave: x, afterSave: y })\n'
    const root = await project({ 'src/a.ts': source })
    const found = await hookNames(root, {})

    expect(found).toHaveLength(2)
    expect(found.some(one => one.fixes?.some(fix => fix.safe))).toBe(false)
  })

  it('reads nothing off a function that is not the library\'s', async () => {
    const root = await project({ 'src/own.ts': 'import { cms } from \'./mine\'\nexport const a = cms({ onSave: x })\n' })

    expect(await hookNames(root, {})).toEqual([])
  })

  it('is silent when the lint is allowed', async () => {
    const root = await project({ 'src/a.ts': 'import { cms } from \'@kayjs/cms\'\nexport const a = cms({ onSave: x })\n' })

    expect(await hookNames(root, { lints: { 'deprecated-hook-names': 'allow' } })).toEqual([])
  })
})
