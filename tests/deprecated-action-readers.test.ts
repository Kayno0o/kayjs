import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { actionReaders } from '../src/check/action-readers'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>) {
  const root = await scratchDir('action-readers-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const found = await actionReaders(root, {})

  await applySafeFixes(root, found)

  return { root, found, read: async (path: string) => Bun.file(join(root, path)).text() }
}

describe('deprecated-action-readers', () => {
  it('writes form. before the readers of an action declared in the fence, read in the fence and the template', async () => {
    const page = '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String() }), () => undefined)\nconst bad = add.failed()?.data\nconst stale = add.with({ title: \'x\' })\nconst again = stale.error(\'title\')\n---\nform(action={add})\n  input(name="title" aria-invalid={add.error(\'title\') ? \'true\' : undefined})\n  if add.failed()\n    p {add.error()}\n  p {add.data()} {add.pending()}\n'
    const { root, found, read } = await fixed({ 'src/routes/page.kay': page })

    try {
      expect(found).toHaveLength(5)
      expect(found.every(one => one.code === 'deprecated-action-readers' && one.fixes?.[0]?.safe === true)).toBe(true)
      expect(await read('src/routes/page.kay')).toBe(page.replace('add.failed()?.data', 'add.form.failed()?.data').replace('stale.error', 'stale.form.error').replace('add.error(\'title\')', 'add.form.error(\'title\')').replace('if add.failed()', 'if add.form.failed()').replace('{add.error()}', '{add.form.error()}'))
      expect(await actionReaders(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds an action imported in lowercase from a .kay file, in a script or a template, validate included', async () => {
    const script = 'import { join } from \'./routes/join.kay\'\n\nexport const check = async (form: HTMLFormElement) => (await join.validate(form, \'email\')) && join.error(\'email\') === undefined\n'
    const page = '---\nimport { join } from \'./routes/join.kay\'\n---\nform(action={join})\n  if join.failed()\n    p {join.error(\'email\')}\n'
    const { root, found, read } = await fixed({ 'src/script.ts': script, 'src/form.kay': page })

    try {
      expect(found).toHaveLength(4)
      expect(await read('src/script.ts')).toBe(script.replace('join.validate', 'join.form.validate').replace('join.error', 'join.form.error'))
      expect(await read('src/form.kay')).toBe(page.replace('join.failed', 'join.form.failed').replace('join.error', 'join.form.error'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves what is no action: a track handle, a console, a component, a name bound twice, a shadowed name, a queue', async () => {
    const page = '---\nimport { action } from \'kay\'\nimport Card from \'./card.kay\'\nimport { jobs } from \'./queue\'\n\nconst add = action(() => 1)\nconst save = add.track()\nconst other = action(() => 2)\nlet other2 = 0\nconsole.error(save.error(), Card.error(), jobs.failed())\nexport const run = (add: { error: () => string }) => add.error()\n---\nif save.error()\n  p {save.error()}\nfor other of [1]\n  p {other.failed()}\n'
    const { root, found, read } = await fixed({ 'src/routes/page.kay': page })

    try {
      expect(found.map(one => one.line)).toEqual([])
      expect(await read('src/routes/page.kay')).toBe(page)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours kay-allow-file', async () => {
    const page = '// kay-allow-file deprecated-action-readers -- covers the old names\nimport { add } from \'./page.kay\'\n\nexport const a = add.failed()\n'
    const { root, found } = await fixed({ 'src/a.ts': page })

    try {
      expect(found).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
