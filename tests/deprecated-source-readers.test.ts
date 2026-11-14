import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { sourceReaders } from '../src/check/source-readers'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('source-readers-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()
const HEAD = 'import { local, resource, socket, stream } from \'kay\'\nimport chat from \'./api/chat\'\nimport { save } from \'./notes\'\n\nconst list = resource(chat, \'/\')\nconst feed = stream(chat, \'/feed\')\nconst room = socket(chat, \'/room\')\nconst notes = local({ key: \'id\', read: () => [], put: save })\n'

async function fixed(files: Record<string, string>): Promise<{ root: string, found: Awaited<ReturnType<typeof sourceReaders>> }> {
  const root = await project(files)
  const found = await sourceReaders(root, {})

  await applySafeFixes(root, found)

  return { root, found }
}

describe('deprecated-source-readers', () => {
  it('renames the readers of each source, in a script, a fence and a template', async () => {
    const script = `${HEAD}\nexport const a = () => list.value()\nexport const b = () => feed.last()\nexport const c = () => room.last()?.text\nexport const d = () => notes.rows().length + notes.unsynced()\nexport const e = () => notes.syncStatus() === 'offline'\n`
    const page = `---\n${HEAD}---\np {list.value()?.length} {feed.last()} {notes.rows().length} {notes.unsynced()}\nif notes.syncStatus() === 'unsynced'\n  p wait\n`
    const { root, found } = await fixed({ 'src/script.ts': script, 'src/routes/page.kay': page })

    try {
      expect(found).toHaveLength(11)
      expect(found.every(one => one.code === 'deprecated-source-readers' && one.fixes?.[0]?.safe === true)).toBe(true)
      expect(await read(root, 'src/script.ts')).toBe(script.replace('list.value()', 'list.data()').replace('feed.last()', 'feed.data()').replace('room.last()', 'room.data()').replace('notes.rows()', 'notes.data()').replace('notes.unsynced()', 'notes.sync.queued()').replace('notes.syncStatus()', 'notes.sync.status()'))
      expect(await read(root, 'src/routes/page.kay')).toBe(page.replace('list.value()', 'list.data()').replace('feed.last()', 'feed.data()').replace('notes.rows()', 'notes.data()').replace('notes.unsynced()', 'notes.sync.queued()').replace('notes.syncStatus()', 'notes.sync.status()'))
      expect(await sourceReaders(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves onSuccess and onSync to onData, the event\'s data and rows to value', async () => {
    const script = `import { local } from 'kay'\nimport { save } from './notes'\nimport { add } from './actions'\n\nconst saving = add.track({ onSuccess: ({ data, input }) => toast(data, input), onError: ({ error }) => toast(error) })\nsaving.onSuccess(({ data: made }) => toast(made))\nsaving.onSuccess(() => toast())\nconst notes = local({ key: 'id', read: () => [], put: save, onSync({ rows }) { toast(rows) } })\nnotes.onSync(({ rows = [] }) => toast(rows))\n`
    const { root, found } = await fixed({ 'src/script.ts': script })

    try {
      expect(found).toHaveLength(5)
      expect(await read(root, 'src/script.ts')).toBe(script.replace('onSuccess: ({ data, input })', 'onData: ({ value: data, input })').replace('saving.onSuccess(({ data: made })', 'saving.onData(({ value: made })').replace('saving.onSuccess(() =>', 'saving.onData(() =>').replace('onSync({ rows })', 'onData({ value: rows })').replace('notes.onSync(({ rows = [] })', 'notes.onData(({ value: rows = [] })'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rewrites succeeded()?.data and a comparison with undefined, in a fence and a template', async () => {
    const page = '---\nimport { make, ping } from \'./actions\'\n\nconst made = make.succeeded()?.data\nconst pinged = ping.succeeded() !== undefined\nconst pending = ping.succeeded() === undefined\nconst quiet = !ping.succeeded()\nconst label = make.succeeded() ? 1 : 2\n---\nif make.succeeded()?.data\n  p {make.succeeded()?.data.id}\nif ping.succeeded() !== undefined\n  p pinged\nelse if ping.succeeded()\n  p again\n'
    const { root, found } = await fixed({ 'src/routes/page.kay': page })

    try {
      expect(found).toHaveLength(9)
      expect(await read(root, 'src/routes/page.kay')).toBe('---\nimport { make, ping } from \'./actions\'\n\nconst made = make.data()\nconst pinged = ping.status() === \'ready\'\nconst pending = ping.status() !== \'ready\'\nconst quiet = ping.status() !== \'ready\'\nconst label = make.status() === \'ready\' ? 1 : 2\n---\nif make.data()\n  p {make.data().id}\nif ping.status() === \'ready\'\n  p pinged\nelse if ping.status() === \'ready\'\n  p again\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix what has no exact rewrite', async () => {
    const script = `${HEAD}\nimport { make } from './actions'\nexport const a = () => make.succeeded()\nexport const b = () => make.succeeded()?.data?.id\nexport const handler = ({ data }: { data: string }) => data\nconst saving = make.track({ onSuccess: handler })\nconst other = make.track({ onSuccess: event => event.data })\nconst short = make.track({ onSuccess })\nconst onSuccess = () => undefined\n`
    const { root, found } = await fixed({ 'src/script.ts': script })

    try {
      expect(found.filter(one => one.fixes === undefined)).toHaveLength(4)
      expect(await read(root, 'src/script.ts')).toContain('onSuccess: handler')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a name that is no source, a name bound twice and the words of a template alone', async () => {
    const page = `---\nimport { resource } from 'kay'\nimport chat from './api/chat'\n\nconst list = resource(chat, '/')\nconst other = { value: () => 1, last: () => 2, rows: () => 3 }\nlet again = resource(chat, '/a')\nagain = resource(chat, '/b')\n---\np {other.value()} {other.last()} {other.rows()}\np {again.value()}\np call list.value() to read it\nmarkdown\n  Use list.value() here\nfor list of lists\n  p {list.value()}\n`
    const root = await project({ 'src/routes/page.kay': page })

    try {
      expect(await sourceReaders(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
