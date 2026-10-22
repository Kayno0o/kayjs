import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { check, configCheckOptions } from '../src/check'
import { loadConfig } from '../src/config'
import { generate, generatedFiles } from '../src/generate'
import { parseFields, resourceFiles, withTable } from '../src/generate-resource'
import { createProject, PRESETS } from '../src/new'
import { lintInProcess } from './scaffold-lint'
import { scratchDir } from './scratch'

const repo = join(import.meta.dir, '..')
// A Postgres whose user may create databases, for the generated resource's tests: CI sets it.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

async function run(dir: string, ...args: string[]) {
  return runWith(dir, {}, ...args)
}

async function runWith(dir: string, env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

it('writes a page with its test, Tailwind classes only when the project has Tailwind', () => {
  const plain = generatedFiles('page', 'contact-us', { tailwind: false, tests: true, auth: false })
  const styled = generatedFiles('page', 'blog/[slug]', { tailwind: true, tests: true, auth: false })

  expect(plain['src/routes/contact-us.kay']).toBe('head\n  title Contact us\nh1 Contact us\n')
  expect(plain['tests/contact-us.test.ts']).toContain('site.visit(\'/contact-us\')')
  expect(Object.keys(styled)).toEqual(['src/routes/blog/[slug].kay'])
  expect(styled['src/routes/blog/[slug].kay']).toContain('h1.text-3xl.font-bold [slug]')
  expect(Object.keys(generatedFiles('page', '(shop)/index', { tailwind: false, tests: false, auth: false }))).toEqual(['src/routes/(shop)/index.kay'])
  expect(generatedFiles('page', 'pricing', { tailwind: false, tests: true, auth: true })['tests/pricing.test.ts']).toContain('/auth/sign-in')
})

it('refuses names that are no route, component or action', () => {
  const project = { tailwind: false, tests: false, auth: false }

  expect(() => generatedFiles('page', '../etc', project)).toThrow('is not a name for a page')
  expect(() => generatedFiles('component', 'a b', project)).toThrow('is not a name for a component')
  expect(() => generatedFiles('component', '[x]', project)).toThrow('is not a name for a component')
  expect(() => generatedFiles('action', 'remove-tissue', project)).toThrow('is not a name for an action')
  expect(() => generatedFiles('api', '/', project)).toThrow('is not a name for a api')
})

it('writes into a project, refusing a file that exists and honouring --dry-run', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })

  expect((await generate(dir, 'page', 'pricing', { dryRun: true })).written).toEqual(['src/routes/pricing.kay', 'tests/pricing.test.ts'])
  expect(await Bun.file(join(dir, 'src/routes/pricing.kay')).exists()).toBe(false)

  await generate(dir, 'page', 'pricing')
  await expect(generate(dir, 'page', 'pricing')).rejects.toThrow('nothing was written, src/routes/pricing.kay, tests/pricing.test.ts already exist')
  await expect(generate(dir, 'widget', 'x')).rejects.toThrow('widget is none of page')
  await expect(generate(join(dir, 'src'), 'page', 'x')).rejects.toThrow('no package.json')
  await generate(dir, 'action', 'save')
  await expect(generate(dir, 'action', 'action')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'page', 'save')).resolves.toEqual({ written: ['src/routes/save.kay', 'tests/save.test.ts'] })
  await expect(generate(dir, 'page', 'pricing/index')).rejects.toThrow('src/routes/pricing.kay already exists')
  await expect(generate(dir, 'action', 'interface')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'package')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'eval')).rejects.toThrow('that are no reserved word')
  await expect(generate(dir, 'action', 'arguments')).rejects.toThrow('that are no reserved word')
})

it('skips the rival of the root index page', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })
  await rm(join(dir, 'src/routes/index.kay'), { force: true })
  await Bun.write(join(dir, 'src/routes.kay'), 'h1 Rival\n')

  expect((await generate(dir, 'page', 'index')).written).toContain('src/routes/index.kay')
  await expect(generate(dir, 'page', 'team/index')).resolves.toBeDefined()
  await Bun.write(join(dir, 'src/routes/docs.kay'), 'h1 Docs\n')
  await expect(generate(dir, 'page', 'docs/index')).rejects.toThrow('src/routes/docs.kay already exists')
})

it('adds an action to an existing _actions.kay that holds a server fence alone', async () => {
  const dir = join(await scratchDir('generate-'), 'app')
  const actions = join(dir, 'src/routes/team/_actions.kay')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await generate(dir, 'action', 'team/first')

  expect(await Bun.file(actions).text()).toStartWith('--- server\nimport { s } from \'kay\'\n')

  expect((await generate(dir, 'action', 'team/second', { dryRun: true })).written).toEqual(['src/routes/team/_actions.kay', 'tests/action-team-second.test.ts'])
  expect(await Bun.file(actions).text()).not.toContain('second')

  expect((await generate(dir, 'action', 'team/second')).written).toEqual(['src/routes/team/_actions.kay', 'tests/action-team-second.test.ts'])

  const text = await Bun.file(actions).text()

  expect(text.match(/import \{ s \}/g)).toHaveLength(1)
  expect(text).toContain('export const first = action(')
  expect(text).toContain('\n\nexport const second = action(')
  expect(text.endsWith(')\n')).toBe(true)

  await expect(generate(dir, 'action', 'team/second')).rejects.toThrow('already exports `second`')
  await expect(generate(dir, 'action', 'team/first')).rejects.toThrow('already exports `first`')
  expect(await Bun.file(actions).text()).toBe(text)

  await Bun.write(actions, '--- server\nexport const legacy = action(s.Object({}), () => 1)\n')
  await generate(dir, 'action', 'team/third')
  expect(await Bun.file(actions).text()).toStartWith('--- server\nimport { s } from \'kay\'\n\nexport const legacy')

  await Bun.write(actions, '--- server\r\nimport { a } from \'a\'\r\nexport function* team() {}\r\n')
  await generate(dir, 'action', 'team/crlf')
  expect(await Bun.file(actions).text()).toStartWith('--- server\r\nimport { a } from \'a\'\r\nimport { s } from \'kay\'\r\nexport function* team() {}\r\n\r\nexport const crlf = action(')
  expect(await Bun.file(actions).text()).not.toMatch(/[^\r]\n/)
  await expect(generate(dir, 'action', 'team/team')).rejects.toThrow('already exports `team`')

  const declared: [source: string, name: string, message: string][] = [
    ['export const { picked } = make()', 'picked', 'already exports'],
    ['import { s } from \'kay\'\nimport helper from \'./helper\'', 'helper', 'already declares or imports'],
    ['import {\n  other as renamed,\n  more,\n} from \'./x\'', 'renamed', 'already declares or imports'],
    ['const local = 1', 'local', 'already declares or imports'],
    ['export const { a = 1, defaulted } = make()', 'defaulted', 'already exports'],
    ['const { a: inner } = make()', 'inner', 'already declares or imports'],
    ['const { a = {}, picked } = make()', 'picked', 'already declares or imports'],
    ['const local = 1\nexport { local as shown }', 'shown', 'already exports'],
    ['export { renamed as other } from \'./x\'', 'other', 'already exports'],
    ['export { default as fromDefault } from \'./x\'', 'fromDefault', 'already exports'],
    ['export default function defaulted() {}', 'defaulted', 'already declares or imports'],
    ['export default class Kept {}', 'Kept', 'already declares or imports'],
    ['declare function ambient(): void', 'ambient', 'already declares or imports'],
    ['import equal = require(\'./x\')', 'equal', 'already declares or imports'],
  ]

  for (const [source, name, message] of declared) {
    await Bun.write(actions, `--- server\n${source}\n`)
    await expect(generate(dir, 'action', `team/${name}`)).rejects.toThrow(message)
    expect(await Bun.file(actions).text()).toBe(`--- server\n${source}\n`)
  }

  await Bun.write(actions, '--- server\nimport { other as renamed } from \'./x\'\nconst { a: inner } = make()\n')
  await generate(dir, 'action', 'team/other')
  await generate(dir, 'action', 'team/a')

  // A fence that does not parse is reported, not appended to.
  await Bun.write(actions, '--- server\nexport const broken = {\n')
  await expect(generate(dir, 'action', 'team/fix')).rejects.toThrow('does not parse')
  expect(await Bun.file(actions).text()).toBe('--- server\nexport const broken = {\n')

  // A name only a comment, a string, a handler's own local, an unexported alias source or a star re-export mentions is free.
  for (const [source, name] of [
    ['// user is taken\nexport const other = 1', 'user'],
    ['export const other = \'const user = 1\'', 'visitor'],
    ['export const other = () => {\n  const user = 1\n  function run() {}\n  return user\n}', 'person'],
    ['export const other = ({ member }: { member: string }) => member', 'member'],
    ['const local = 1\nexport { local as shown }', 'local2'],
    ['export * from \'./x\'', 'guest'],
  ]) {
    await Bun.write(actions, `--- server\n${source}\n`)
    await generate(dir, 'action', `team/${name}`)
    expect(await Bun.file(actions).text()).toContain(`export const ${name} = action(`)
  }

  // A name that only starts with a keyword is not a declaration of the keyword's.
  await Bun.write(actions, '--- server\nexport const constant = 1\nconst letter = 2\n')
  await generate(dir, 'action', 'team/ant')
  await generate(dir, 'action', 'team/ter')

  await Bun.write(actions, '--- server\nimport { s } from \'kay\'\n\nexport const sent = action(s.Object({}), () => 1)\n---\nbutton Go\n')
  await expect(generate(dir, 'action', 'team/fourth')).rejects.toThrow('add the action by hand')
  expect(await Bun.file(actions).text()).toContain('button Go')
  expect(await Bun.file(join(dir, 'tests/action-team-fourth.test.ts')).exists()).toBe(false)
})

it('writes a guard test visiting a page below the folder when there is one', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await Bun.write(join(dir, 'src/routes/admin/users/[id].kay'), 'h1 User\n')
  await Bun.write(join(dir, 'src/routes/admin/users/index.kay'), 'h1 Users\n')

  expect((await generate(dir, 'guard', 'admin')).written).toEqual(['src/routes/admin/_guard.ts', 'tests/guard-admin.test.ts'])
  expect(await Bun.file(join(dir, 'tests/guard-admin.test.ts')).text()).toContain('site.visit(\'/admin/users\')')

  // A `(group)` folder is part of the glob's syntax; a `[param]` one has no page to visit.
  await Bun.write(join(dir, 'src/routes/(staff)/desk.kay'), 'h1 Desk\n')
  await Bun.write(join(dir, 'src/routes/[org]/home.kay'), 'h1 Home\n')
  expect((await generate(dir, 'guard', '(staff)')).written).toEqual(['src/routes/(staff)/_guard.ts', 'tests/guard-staff.test.ts'])
  expect(await Bun.file(join(dir, 'tests/guard-staff.test.ts')).text()).toContain('site.visit(\'/desk\')')
  expect((await generate(dir, 'guard', '[org]')).written).toEqual(['src/routes/[org]/_guard.ts'])
  await rm(join(dir, 'src/routes'), { recursive: true })
  expect((await generate(dir, 'guard', 'norouts')).written).toEqual(['src/routes/norouts/_guard.ts'])
  expect((await generate(dir, 'guard', 'empty')).written).toEqual(['src/routes/empty/_guard.ts'])
  expect(generatedFiles('guard', 'admin', { tailwind: false, tests: true, auth: true, guardPage: '/admin' })['tests/guard-admin.test.ts']).toContain('/auth/sign-in')
})

it('runs as kay generate', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })

  const made = await run(dir, 'generate', 'component', 'card')

  expect(made.code).toBe(0)
  expect(made.stdout).toContain('generated component card, 1 file written')
  expect(made.stdout).toContain('src/components/card.kay')
  expect(JSON.parse((await run(dir, 'generate', 'island', 'likes', '--format', 'json', '--dry-run')).stdout)).toEqual({ kind: 'island', name: 'likes', written: ['src/components/likes.kay'], dryRun: true })

  const again = await run(dir, 'generate', 'component', 'card')

  expect(again.code).toBe(1)
  expect(again.stderr).toContain('nothing was written')
  expect((await run(dir, 'generate', 'page')).code).toBe(1)
})

// What it writes passes kay check and runs under bun test, in a project of the server preset.
it('writes files that pass kay check and their own tests', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await mkdir(join(dir, 'src/routes'), { recursive: true })
  await Bun.write(join(dir, 'src/routes/admin/index.kay'), 'head\n  title Admin\nh1 Admin\n')

  for (const [kind, name] of [['page', 'pricing'], ['page', 'blog/[slug]'], ['component', 'card'], ['island', 'likes'], ['action', 'team/removeTissue'], ['action', 'save'], ['api', 'notes'], ['guard', 'admin']] as const)
    await generate(dir, kind, name)

  await generate(dir, 'action', 'team/addTissue')

  await Bun.write(join(dir, 'src/routes/team/index.kay'), 'head\n  title Team\nh1 Team\n')

  expect(await check(dir, configCheckOptions(await loadConfig(dir)))).toEqual([])

  expect((await lintInProcess(dir, '.')).filter(result => result.messages.length > 0).map(result => ({ file: result.filePath, messages: result.messages }))).toEqual([])

  const tests = await run(dir, 'test')

  expect(tests.stderr + tests.stdout).toContain(' 0 fail')
  expect(tests.code).toBe(0)
}, 120_000)

const PROJECT = { tailwind: true, tests: true, ui: true, auth: true }

it('signs a resource test in through authTest, or through the former form\'s own auth module', () => {
  const own = resourceFiles('note', ['title:string'], PROJECT).files['tests/notes.test.ts']!
  const module = resourceFiles('note', ['title:string'], { ...PROJECT, authModule: true }).files['tests/notes.test.ts']!

  expect(own).toContain('import { authTest } from \'@kaynooo/kayjs-auth/test\'')
  expect(own).toContain('await authTest(site).signInAs(')
  expect(module).toContain('import { auth } from \'../src/auth\'')
  expect(module).toContain('await auth.signInAs(site, ')
})

it('writes a resource with the table, the actions, the pages and a test, drawn with kayjs-ui when it is installed', () => {
  const ui = resourceFiles('blog-post', ['title:string', 'body:text', 'views:int', 'done:bool'], PROJECT)
  const plain = resourceFiles('category', ['name:string', 'rank:number'], { ...PROJECT, ui: false })

  expect(Object.keys(ui.files)).toEqual(['src/db/blog-post.ts', 'src/routes/blog-posts/_actions.kay', 'src/routes/blog-posts/index.kay', 'src/routes/blog-posts/[id=integer]/edit.kay', 'src/components/blog-posts-table.kay', 'src/components/new-blog-post.kay', 'tests/blog-posts.test.ts'])
  expect(ui.table).toEqual({ name: 'BlogPost', file: './blog-post' })
  expect(ui.files['src/db/blog-post.ts']).toContain('defineTable(\'blog_post\'')
  expect(ui.files['src/db/blog-post.ts']).toContain('done: f.boolean().default(false),')
  expect(ui.files['src/routes/blog-posts/index.kay']).toContain('BlogPostsTable(rows={blogPosts})')
  expect(ui.files['src/routes/blog-posts/[id=integer]/edit.kay']).toContain('SaveForm(action={update}')
  expect(ui.files['src/components/new-blog-post.kay']).toContain('FormDialog(')
  expect(Object.keys(plain.files)).toEqual(['src/db/category.ts', 'src/routes/categories/_actions.kay', 'src/routes/categories/index.kay', 'src/routes/categories/[id=integer]/edit.kay', 'src/routes/categories/new.kay', 'tests/categories.test.ts'])
  expect(plain.files['src/routes/categories/index.kay']).toContain('  table\n')
  expect(plain.files['src/routes/categories/new.kay']).toContain('form(action={create})')
  expect(Object.keys(resourceFiles('note', ['title:string'], { ...PROJECT, tests: false }).files)).not.toContain('tests/notes.test.ts')
  expect(resourceFiles('note', ['count:int'], PROJECT).files['tests/notes.test.ts']).toContain('with an invalid count')
  expect(resourceFiles('note', ['done:boolean'], PROJECT).files['tests/notes.test.ts']).toContain('refuses a note with an invalid done')
  expect(resourceFiles('note', ['title:string'], PROJECT).files['tests/notes.test.ts']).toContain('const id = String((await db.repo(Note)')
  expect(resourceFiles('note', ['title:string'], PROJECT).files['tests/notes.test.ts']).not.toContain('\'1\'')
  // A boolean's `true` matches anything, so a list shows the first other field, or the absence of the empty message.
  expect(resourceFiles('note', ['done:boolean', 'title:string'], PROJECT).files['tests/notes.test.ts']).toContain('toContain(\'First\')')
  expect(resourceFiles('note', ['done:boolean'], PROJECT).files['tests/notes.test.ts']).toContain('not.toContain(\'No notes yet.\')')
  // A name already plural stays so, its list variable apart from its row.
  const news = resourceFiles('news', ['title:string'], { ...PROJECT, ui: false })

  expect(Object.keys(news.files)).toContain('src/routes/news/index.kay')
  expect(news.files['src/routes/news/index.kay']).toContain('for news of newsList')
  expect(Object.keys(resourceFiles('address', ['title:string'], PROJECT).files)).toContain('src/routes/addresses/index.kay')
  expect(Object.keys(resourceFiles('tags', ['title:string'], PROJECT).files)).toContain('src/routes/tags/index.kay')
  expect(Object.keys(resourceFiles('status', ['title:string'], PROJECT).files)).toContain('src/routes/statuses/index.kay')
})

it('refuses a resource named or fielded wrongly', () => {
  expect(() => resourceFiles('a b', ['title:string'], PROJECT)).toThrow('is not a name for a resource')
  expect(() => resourceFiles('action', ['title:string'], PROJECT)).toThrow('names something the generated files use')
  expect(() => resourceFiles('table', ['title:string'], PROJECT)).toThrow('names something the generated files use')
  expect(() => resourceFiles('post', [], PROJECT)).toThrow('at least one field')
  expect(() => parseFields(['title'])).toThrow('is not a field')
  expect(() => parseFields(['title:date'])).toThrow('is not a field')
  expect(() => parseFields(['id:int'])).toThrow('cannot be a field')
  expect(() => parseFields(['delete:string'])).toThrow('cannot be a field')
  expect(() => parseFields(['title:string', 'title:text'])).toThrow('written twice')
})

it('adds a table to the tables of src/db/tables.ts, imported in order', () => {
  const table = { name: 'Post', file: './post' }
  const base = 'import { authTables } from \'@kaynooo/kayjs-auth/pg\'\n\n// Add the app\'s own tables.\nexport const tables = [...authTables]\n'
  const once = withTable(base, table)!

  expect(once).toBe('import { authTables } from \'@kaynooo/kayjs-auth/pg\'\nimport { Post } from \'./post\'\n\n// Add the app\'s own tables.\nexport const tables = [...authTables, Post]\n')
  expect(withTable(once, { name: 'Comment', file: './comment' })).toContain('import { Comment } from \'./comment\'\nimport { Post } from \'./post\'')
  expect(withTable(once, { name: 'Tag', file: './tag' })).toContain('import { Post } from \'./post\'\nimport { Tag } from \'./tag\'')
  expect(withTable(once, { name: 'Tag', file: './tag' })).toContain('[...authTables, Post, Tag]')
  expect(withTable('export const tables = [\n  A,\n]\n', table)).toBe('import { Post } from \'./post\'\n\nexport const tables = [\n  A, Post\n]\n')
  expect(withTable('export const tables = []\n', table)).toContain('tables = [Post]')
  expect(withTable('export const tables = [...authTables]\r\n', table)).not.toMatch(/[^\r]\n/)
  expect(withTable('const tables = 1\n', table)).toBeUndefined()
  // A list it could not extend as written is left to be edited by hand.
  expect(withTable('export const tables = [\n  A, // main\n]\n', table)).toBeUndefined()
  expect(withTable('export const tables = [...authTables, ...more[0]]\n', table)).toBeUndefined()
  expect(withTable('export const tables = [A /* ] */]\n', table)).toBeUndefined()
  expect(withTable('export const tables = [A].concat(more)\n', table)).toBeUndefined()
  expect(() => withTable(once, table)).toThrow('already mentions `Post`')
})

it('stops a resource in a project without a database, and writes nothing over what exists', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
  await expect(generate(dir, 'resource', 'post', { fields: ['title:string'] })).rejects.toThrow('run `kay add postgres`')

  const postgres = join(await scratchDir('generate-'), 'app')

  await createProject(postgres, { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'] })
  await expect(generate(postgres, 'resource', 'post')).rejects.toThrow('at least one field')

  const dry = await generate(postgres, 'resource', 'post', { fields: ['title:string'], dryRun: true })

  expect(dry.written[0]).toBe('src/db/tables.ts')
  expect(await Bun.file(join(postgres, 'src/db/tables.ts')).text()).not.toContain('Post')

  await generate(postgres, 'resource', 'post', { fields: ['title:string'] })
  await expect(generate(postgres, 'resource', 'post', { fields: ['title:string'] })).rejects.toThrow('already mentions')
  await Bun.write(join(postgres, 'src/routes/tags.kay'), 'h1 Tags\n')
  await expect(generate(postgres, 'resource', 'tag', { fields: ['label:string'] })).rejects.toThrow('src/routes/tags.kay already exists')
  await rm(join(postgres, 'src/db/tables.ts'))
  await expect(generate(postgres, 'resource', 'label', { fields: ['label:string'] })).rejects.toThrow('has no `export const tables')
  expect(await Bun.file(join(postgres, 'src/db/label.ts')).exists()).toBe(false)
})

it('runs as kay generate resource, the fields before an optional folder', async () => {
  const dir = join(await scratchDir('generate-'), 'app')

  await createProject(dir, { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'] })

  const made = await run(dirname(dir), 'generate', 'resource', 'post', 'title:string', 'done:boolean', 'app', '--format', 'json', '--dry-run')

  const document = JSON.parse(made.stdout) as { written: string[] }

  expect(document).toMatchObject({ kind: 'resource', name: 'post', dryRun: true })
  expect(document.written).toContain('src/routes/posts/_actions.kay')
  expect((await run(dir, 'generate', 'page', 'x', 'app', 'extra')).code).toBe(1)

  // A field without its type is named, not taken for the folder.
  const untyped = await run(dir, 'generate', 'resource', 'post', 'title', '--dry-run')

  expect(untyped.code).toBe(1)
  expect(untyped.stderr).toContain('`title` is not a field')
  expect((await run(dirname(dir), 'generate', 'resource', 'post', 'title:string', 'app', '--dry-run')).code).toBe(0)
})

// What a resource writes passes kay check and the project's lint, and its test passes on a migrated database, with kayjs-ui and without.
for (const ui of [true, false]) {
  it(`writes a resource that passes kay check, lint and its own tests ${ui ? 'with' : 'without'} kayjs-ui`, async () => {
    const dir = join(await scratchDir('generate-'), 'app')

    await createProject(dir, { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'] })

    const manifestText = await Bun.file(join(dir, 'package.json')).text()

    // The pages are drawn by the dependency on kayjs-ui, which is put back for the check as kayjs-auth's own pages need it.
    if (!ui) {
      const manifest = JSON.parse(manifestText) as { dependencies: Record<string, string> }

      delete manifest.dependencies['@kaynooo/kayjs-ui']
      await Bun.write(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
    }

    await generate(dir, 'resource', 'blog-post', { fields: ['title:string', 'body:text', 'views:int', 'rating:float', 'done:boolean'] })
    // A name already plural and a resource of booleans alone.
    await generate(dir, 'resource', 'news', { fields: ['active:boolean'] })
    await Bun.write(join(dir, 'package.json'), manifestText)

    expect(await check(dir, configCheckOptions(await loadConfig(dir)))).toEqual([])

    expect((await lintInProcess(dir, '.')).filter(result => result.messages.length > 0).map(result => ({ file: result.filePath, messages: result.messages }))).toEqual([])

    if ((TEST_DATABASE_URL ?? '') === '')
      return

    const scratch = new URL(TEST_DATABASE_URL!)
    const admin = new Bun.SQL(Object.assign(new URL(scratch), { pathname: '/postgres' }).href)
    const name = `kay_generate_resource_${process.pid}_${ui ? 'ui' : 'plain'}`

    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`)
    await admin.unsafe(`CREATE DATABASE ${name}`)

    try {
      const migrate = Bun.spawn([join(repo, 'node_modules/.bin/pg-orm'), 'generate', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, MIGRATE_DATABASE_URL: Object.assign(new URL(scratch), { pathname: `/${name}` }).href } })
      const [generated, errors] = await Promise.all([new Response(migrate.stdout).text(), new Response(migrate.stderr).text(), migrate.exited])

      expect({ generated: generated.includes('Generated'), errors }).toEqual({ generated: true, errors: expect.not.stringContaining('rror') })

      const tests = await runWith(dir, { DATABASE_URL: TEST_DATABASE_URL! }, 'test', 'tests/blog-posts.test.ts', 'tests/news.test.ts')

      expect({ code: tests.code, report: tests.stderr + tests.stdout }).toEqual({ code: 0, report: expect.stringContaining(' 6 pass') })
    }
    finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`)
      await admin.close()
    }
  }, 120_000)
}
