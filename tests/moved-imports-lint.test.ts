import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { movedImports } from '../src/check/moved-imports'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('moved-imports-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()

it('changes the module of an import holding only moved names, keeping its quotes', async () => {
  const root = await project({ 'src/a.ts': 'import { normalizeEmail, type PasswordProblem as Problem } from "@kaynooo/kayjs-auth"\n\nexport const a = [normalizeEmail, null as Problem | null]\n', 'src/b.ts': 'import type { EntryForm } from \'@kaynooo/kayjs-cms\'\n\nexport type B = EntryForm\n' })

  try {
    const found = await movedImports(root, {})

    expect(found).toHaveLength(2)
    expect(found.every(diagnostic => diagnostic.fixes?.[0]?.safe)).toBe(true)
    await applySafeFixes(root, found)
    expect(await read(root, 'src/a.ts')).toContain('} from "@kaynooo/kayjs-auth/rules"')
    expect(await read(root, 'src/b.ts')).toContain('import type { EntryForm } from \'@kaynooo/kayjs-cms/form\'')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('moves the names of a mixed import to an import of their own and leaves the rest', async () => {
  const mixed = 'import { createAuth, passwordProblem, usernameProblem as problem } from \'@kaynooo/kayjs-auth\'\nimport type { Auth, EntryForm, FormScope } from \'@kaynooo/kayjs-cms\'\n\nexport const a = [createAuth, passwordProblem, problem, null as Auth | EntryForm | FormScope | null]\n'
  const root = await project({ 'src/mixed.ts': mixed })

  try {
    await applySafeFixes(root, await movedImports(root, {}))
    expect(await read(root, 'src/mixed.ts')).toBe('import { createAuth } from \'@kaynooo/kayjs-auth\'\nimport { passwordProblem, usernameProblem as problem } from \'@kaynooo/kayjs-auth/rules\'\nimport type { Auth } from \'@kaynooo/kayjs-cms\'\nimport type { EntryForm, FormScope } from \'@kaynooo/kayjs-cms/form\'\n\nexport const a = [createAuth, passwordProblem, problem, null as Auth | EntryForm | FormScope | null]\n')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reports with no fix a default beside the moved names, ignores other modules and honours the level', async () => {
  const root = await project({ 'src/default.ts': 'import auth, { normalizeEmail } from \'@kaynooo/kayjs-auth\'\n\nexport const a = [auth, normalizeEmail]\n', 'src/other.ts': 'import { normalizeEmail } from \'./mine\'\nimport { normalizeEmail as again } from \'@kaynooo/kayjs-auth/rules\'\n\nexport const o = [normalizeEmail, again]\n', 'src/routes/page.kay': '---\nimport { emailProblem } from \'@kaynooo/kayjs-auth\'\n\nconst bad = emailProblem(\'x\')\n---\np {bad}\n' })

  try {
    const found = await movedImports(root, {})

    expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes === undefined])).toEqual([['src/default.ts', true], ['src/routes/page.kay', false]])
    await applySafeFixes(root, found)
    expect(await read(root, 'src/routes/page.kay')).toContain('from \'@kaynooo/kayjs-auth/rules\'')
    expect(await movedImports(root, { lints: { 'deprecated-import-path': 'allow' } })).toEqual([])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
