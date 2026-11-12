import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { persistedStorage } from '../src/check/persisted-storage'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('persisted-storage-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-persisted-storage', () => {
  it('moves a call to the entry of its storage and drops the option, in a script and a fence', async () => {
    const script = [
      'import { persisted } from \'kay\'',
      'import * as kay from \'kay\'',
      '',
      'export const a = persisted(\'a\', \'\', { storage: \'local\' })',
      'export const b = persisted<boolean>(\'b\', false, { storage: \'local\', sync: false })',
      'export const c = persisted(\'c\', \'x\', { values: [\'x\', \'y\'], storage: \'query\' })',
      'export const d = persisted(\'d\', \'x\', { history: \'push\', storage: \'query\', values: [\'x\'] })',
      'export const e = persisted(\'e\', \'x\', { storage: \'cookie\', maxAge: \'30d\' })',
      'export const f = persisted(\'f\', \'x\', { storage: \'cookie\' })',
      'export const g = kay.persisted(\'g\', 1, { storage: \'local\' })',
      'export const h = persisted(\'h\', \'x\', { maxAge: \'30d\' })',
      'export const i = persisted(\'i\', \'x\', { storage: \'local\' },)',
      '',
    ].join('\n')

    const fixed = [
      'import { persisted } from \'kay\'',
      'import * as kay from \'kay\'',
      '',
      'export const a = persisted.local(\'a\', \'\')',
      'export const b = persisted.local<boolean>(\'b\', false, { sync: false })',
      'export const c = persisted.query(\'c\', \'x\', { values: [\'x\', \'y\'] })',
      'export const d = persisted.query(\'d\', \'x\', { history: \'push\', values: [\'x\'] })',
      'export const e = persisted(\'e\', \'x\', { maxAge: \'30d\' })',
      'export const f = persisted(\'f\', \'x\')',
      'export const g = kay.persisted.local(\'g\', 1)',
      'export const h = persisted(\'h\', \'x\', { maxAge: \'30d\' })',
      'export const i = persisted.local(\'i\', \'x\',)',
      '',
    ].join('\n')

    const page = '---\nimport { persisted } from \'kay\'\n\nconst draft = persisted(\'draft\', \'\', { storage: \'local\' })\n---\np {draft()}\n'
    const root = await project({ 'src/state.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await persistedStorage(root, {})

      expect(found).toHaveLength(9)
      expect(found.every(one => one.code === 'deprecated-persisted-storage' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/state.ts')).text()).toBe(fixed)
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('persisted(\'draft\', \'\', { storage: \'local\' })', 'persisted.local(\'draft\', \'\')'))
      expect(await persistedStorage(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a storage it cannot read, a spread, and an option the entry refuses', async () => {
    const script = [
      'import { persisted } from \'kay\'',
      '',
      'const kind = \'local\' as const',
      'persisted(\'a\', \'x\', { storage: kind })',
      'persisted(\'b\', \'x\', { storage: \'local\', ...more })',
      'persisted(\'c\', \'x\', { storage: \'local\', maxAge: \'1d\' })',
      'persisted(\'d\', \'x\', { storage: \'query\', sync: false })',
      'persisted(\'e\', \'x\', { storage: \'elsewhere\' })',
      '',
    ].join('\n')

    const root = await project({ 'src/state.ts': script })

    try {
      const found = await persistedStorage(root, {})

      expect(found).toHaveLength(5)
      expect(found.every(one => one.fixes === undefined)).toBe(true)
      expect(await persistedStorage(root, { lints: { 'deprecated-persisted-storage': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a call whose removed text holds a comment, and one kept in a session', async () => {
    const script = 'import { persisted } from \'kay\'\n\npersisted(\'a\', \'x\', { sync: false,\n  // why\n  storage: \'local\' })\npersisted(\'b\', \'x\', /* options */ { storage: \'local\' })\npersisted(\'c\', \'x\', { storage: \'session\' })\n'
    const root = await project({ 'src/state.ts': script })

    try {
      const found = await persistedStorage(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(one => one.fixes === undefined)).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the other calls, the other persisted and a persisted not from kay alone', async () => {
    const script = 'import { persisted } from \'kay\'\nimport { persisted as other } from \'./mine\'\n\npersisted(\'a\', \'x\')\npersisted(\'b\', \'x\', { values: [\'x\'] })\npersisted.local(\'c\', \'x\')\nother(\'d\', \'x\', { storage: \'local\' })\nfoo(\'e\', \'x\', { storage: \'local\' })\n'
    const root = await project({ 'src/state.ts': script, 'src/other.ts': 'import { persisted } from \'./mine\'\n\npersisted(\'a\', \'x\', { storage: \'local\' })\n' })

    try {
      expect(await persistedStorage(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
