import type { ErrorName } from '../src/compiler/errors'
import { join } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { KayCompileError, transformKay } from '../src/build/transform'
import { failureProblem } from '../src/commands/command'
import { compileKay } from '../src/compiler'
import { diagnosticInfo, explainDiagnostic, isDiagnosticCode } from '../src/compiler/diagnostics'
import { buildFailure, ERROR_GROUPS, errorCodeOf, errorList, ERRORS, explainError, isErrorCode, KayError, raisedMark } from '../src/compiler/errors'
import { explainLint, LINTS } from '../src/compiler/lints'
import { MarkdownError } from '../src/content/markdown'
import { ContentError } from '../src/content/validate'
import { ExportError } from '../src/server/prerender'

const root = join(import.meta.dir, '..')
const cli = join(root, 'src/cli.ts')
const SLUG_PUNCTUATION = /[^\w\s-]/g
const PLAIN_KAY_ERROR = /new (?:Range|Type)?Error\((?:`|')kay/
const RAISED = /new KayError\(\s*'([\w-]+)'/g
const LITERAL = /'([a-z]+(?:-[a-z]+)+|[a-z]+)'/g

async function kay(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

// The source the codes are raised in, without the registry itself.
async function sources(): Promise<string> {
  const files = ['src/**/*.ts', 'packages/*/src/**/*.ts'].flatMap(pattern => [...new Glob(pattern).scanSync({ cwd: root })]).filter(file => file !== 'src/compiler/errors.ts' && !file.includes('/codec/'))

  return (await Promise.all(files.map(async file => Bun.file(join(root, file)).text()))).join('\n')
}

describe('error codes', () => {
  it('are named apart from the lints, in a group each', () => {
    expect(Object.keys(ERRORS).filter(name => Object.hasOwn(LINTS, name))).toEqual([])
    expect(Object.keys(ERRORS).filter(name => Object.hasOwn(ERROR_GROUPS, name))).toEqual([])
    expect(Object.values(ERRORS).filter(error => !Object.hasOwn(ERROR_GROUPS, error.group))).toEqual([])
  })

  it('are all raised somewhere in the source, and every code raised is registered', async () => {
    const source = await sources()
    const raised = [...source.matchAll(RAISED)].map(match => match[1]!)
    const written = new Set([...source.matchAll(LITERAL)].map(match => match[1]!))

    expect(raised.filter(code => !isErrorCode(code))).toEqual([])
    expect(Object.keys(ERRORS).filter(code => !written.has(code))).toEqual([])
  })

  it('leave no error of build, config, content or export time without one, but in the files that serve a request, scaffold or test', async () => {
    // Raised while serving a request, in the dev server and its tool, the editor, `kay new` or the test helpers: no code, as docs say.
    const uncoded = new Set(['src/add.ts', 'src/dev/inspector.ts', 'src/dev/preload.ts', 'src/dev/tailwind.ts', 'src/generate-resource.ts', 'src/generate.ts', 'src/lsp/rename.ts', 'src/lsp/server.ts', 'src/new.ts', 'src/server/actions.ts', 'src/server/api.ts', 'src/server/avif.ts', 'src/server/card-draw.ts', 'src/server/compress.ts', 'src/server/context-values.ts', 'src/server/crop.ts', 'src/server/event-stream.ts', 'src/server/i18n.ts', 'src/server/image-format.ts', 'src/server/kv.ts', 'src/server/lifecycle.ts', 'src/server/live.ts', 'src/server/loader.ts', 'src/server/mcp.ts', 'src/server/notifications.ts', 'src/server/pg-data.ts', 'src/server/pg-jobs.ts', 'src/server/pg-not-found.ts', 'src/server/pg-redirects.ts', 'src/server/push-crypto.ts', 'src/server/push-store.ts', 'src/server/push.ts', 'src/server/queue.ts', 'src/server/resources.ts', 'src/server/rooms.ts', 'src/server/session.ts', 'src/server/signed.ts', 'src/server/signals.ts', 'src/server/sqlite-live.ts', 'src/server/vitals-store.ts', 'src/server/workflow.ts'])
    const found: string[] = []

    for (const file of new Glob('src/**/*.ts').scanSync({ cwd: root })) {
      if (file.startsWith('src/runtime/') || file.startsWith('src/test/') || uncoded.has(file))
        continue

      if (PLAIN_KAY_ERROR.test(await Bun.file(join(root, file)).text()))
        found.push(file)
    }

    expect(found).toEqual([])
  })

  it('point to a section of llms/ that exists', async () => {
    const missing: string[] = []

    for (const [name, error] of Object.entries(ERRORS)) {
      const file = Bun.file(join(root, error.fix.file))
      const text = await file.exists() ? await file.text() : ''

      if (!new RegExp(`^#{2,4} ${RegExp.escape(error.fix.heading)}$`, 'm').test(text))
        missing.push(name)
    }

    expect(missing).toEqual([])
  })

  it('are listed in llms/errors.md and the docs reference, with a link to the fix', async () => {
    const llms = await Bun.file(join(root, 'llms/errors.md')).text()
    const docs = await Bun.file(join(root, 'docs/src/content/docs/reference/checks.md')).text()

    expect(Object.keys(ERRORS).filter(name => !llms.includes(`| \`${name}\` | ${ERRORS[name as keyof typeof ERRORS].group} |`))).toEqual([])
    expect(Object.keys(ERRORS).filter(name => !docs.includes(`| \`${name}\` | ${ERRORS[name as keyof typeof ERRORS].group} |`))).toEqual([])

    for (const error of Object.values(ERRORS)) {
      const anchor = error.fix.heading.toLowerCase().replaceAll('`', '').replace(SLUG_PUNCTUATION, '').trim().replaceAll(' ', '-')

      expect(llms).toContain(`[${error.fix.heading}](${error.fix.file.startsWith('packages/') ? `../${error.fix.file}` : error.fix.file.replace('llms/', '')}#${anchor})`)
    }
  })

  it('explain a library code from the command line', async () => {
    const { stdout, code } = await kay(['explain', 'ai-error'])

    expect(code).toBe(0)
    expect(stdout).toContain('ai-error')
    expect(stdout).toContain('testing-and-errors.md')
  })

  it('are read off what was thrown, only when kay raised it', () => {
    expect(errorCodeOf(new KayError('content-invalid', 'x'))).toBe('content-invalid')
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined()
    expect(errorCodeOf('text')).toBeUndefined()
  })
})

describe('compile errors', () => {
  const codes = (source: string, filename = 'src/a.kay') => compileKay(source, filename).diagnostics.map(diagnostic => diagnostic.code)

  it('name the group of messages they belong to', () => {
    expect(codes('div\n    p\n  span\n')).toContain('template-syntax')
    expect(codes('head\n  title A\nhead\n  title B\n')).toContain('head-invalid')
    expect(codes('---\nconst { a } = props<{ a: string }>()\nconst { b } = props<{ b: string }>()\n---\np {a}\n')).toContain('fence-invalid')
    expect(codes('--- client\nconst n = 1\n---\np {n}\n', 'src/routes/_layout.kay')).toContain('client-route-fence')
  })

  it('refuse a --- server fence in a component, not in a page or a special file', () => {
    const refused = (filename: string, component: boolean | undefined, fence = '--- server') => {
      const source = `${fence}\nconst a = 1\n---\np {a}\n`

      return compileKay(source, filename, { component }).diagnostics.filter(diagnostic => diagnostic.message.includes('no `--- server` fence')).map(diagnostic => ({ code: diagnostic.code, text: source.slice(diagnostic.start, diagnostic.end) }))
    }

    expect(refused('src/components/c.kay', true)).toEqual([{ code: 'fence-invalid', text: '--- server' }])
    expect(refused('src/components/c.kay', true, '---  server')).toEqual([{ code: 'fence-invalid', text: '---  server' }])
    expect(refused('src/components/c.kay', true, '---\tserver')).toEqual([{ code: 'fence-invalid', text: '---\tserver' }])
    expect(refused('src/routes/index.kay', false)).toEqual([])
    expect(refused('src/components/c.kay', undefined)).toEqual([])
    expect(refused('src/routes/_layout.kay', true)).toEqual([])
    expect(refused('src/routes/_actions.kay', true)).toEqual([])
  })

  it('name --- script for a bare fence after a named one, and fix it by naming the closing line', () => {
    const source = '--- server\nconst a = 1\n---\nimport { route } from \'kay\'\n---\nh1 x\n'
    const found = compileKay(source, 'src/a.kay').diagnostics.find(diagnostic => diagnostic.help?.includes('--- script'))

    expect(found?.help).toContain('--- script')
    expect(found?.fixes?.[0]?.safe).toBe(true)

    const [edit] = found!.fixes![0]!.edits
    const fixed = source.slice(0, edit!.start) + edit!.text + source.slice(edit!.end)

    expect(fixed).toBe('--- server\nconst a = 1\n--- script\nimport { route } from \'kay\'\n---\nh1 x\n')
    expect(compileKay(fixed, 'src/a.kay').diagnostics).toEqual([])
  })

  it('refuse a server fence never closed, but in an _actions.kay, which holds no template', () => {
    const unclosed = '--- server\nexport const a = 1\np hi\n'

    expect(codes(unclosed, 'src/routes/page.kay')).toContain('fence-invalid')
    expect(codes(unclosed, 'src/routes/_layout.kay')).toContain('fence-invalid')
    expect(codes('--- server\nexport const a = 1\n', 'src/routes/admin/_actions.kay')).toEqual([])
  })
})

describe('errors raised while building', () => {
  it('carry the code of the group of their messages', async () => {
    let compile: unknown

    try {
      transformKay('div\n    p\n  span\n', 'src/a.kay', { target: 'ssr' })
    }
    catch (error) {
      compile = error
    }

    expect(compile).toBeInstanceOf(KayCompileError)
    expect(errorCodeOf(compile)).toBe('template-syntax')
    expect(errorCodeOf(new ContentError([{ file: 'a.md', line: 1, message: 'x' }]))).toBe('content-invalid')
    expect(errorCodeOf(new MarkdownError('x', 1))).toBe('markdown-invalid')
    expect(errorCodeOf(new ExportError('x', [{ code: 'export-guard', message: 'x' }]))).toBe('export-guard')
    expect(failureProblem('no such dir', 'json')).toEqual({ severity: 'error', code: 'command-usage', message: 'no such dir' })
    expect(failureProblem(new KayError('export-action', 'kay: x'), 'json').code).toBe('export-action')
    expect(failureProblem(new Error('x'), 'json').code).toBeNull()
  })
})

describe('a failed build', () => {
  const raise = (code: ErrorName, message: string) => void new KayError(code, message)
  const text = 'kay: the editor src/a.kay runs nothing in the browser'

  it('takes the code of the error a log tells of', () => {
    const since = raisedMark()

    raise('inert-editor', text)

    expect(errorCodeOf(buildFailure([{ message: `error: ${text}` }], 'failed', since))).toBe('inert-editor')
  })

  it('picks no code for an empty or a short log message', () => {
    const since = raisedMark()

    raise('inert-editor', text)
    raise('config-default-export', 'x')

    expect(errorCodeOf(buildFailure([{ message: '' }], 'failed', since))).toBeUndefined()
    expect(errorCodeOf(buildFailure([{ message: 'x' }, { message: 'kay' }, {}], 'failed', since))).toBeUndefined()
  })

  it('ignores an error raised before the build started', () => {
    raise('inert-editor', text)

    expect(errorCodeOf(buildFailure([{ message: text }], 'failed', raisedMark()))).toBeUndefined()
  })
})

describe('template errors', () => {
  const found = (source: string, filename = 'src/a.kay') => compileKay(source, filename, { check: true }).diagnostics
  const codes = (source: string, filename?: string) => found(source, filename).map(diagnostic => diagnostic.code)
  // What `kay check --fix` leaves: every safe fix of the first error that has one, its edits applied from the end.
  const fixed = (source: string): string => {
    const edits = found(source).flatMap(diagnostic => diagnostic.fixes?.find(fix => fix.safe)?.edits ?? [])

    return edits.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
  }

  it('give each problem its own code, none the old catch-all', () => {
    const island = (call: string) => codes(`---\nimport Card from './card.kay'\nconst x = 1\n---\n${call}\n`, 'src/routes/index.kay')

    expect(codes('div#a(id="b")')).toContain('duplicate-attribute')
    expect(codes('div(class="a" class="b")')).toContain('duplicate-attribute')
    expect(codes('div.a(class)')).toContain('attribute-invalid')
    expect(codes('div(style:color)')).toContain('attribute-invalid')
    expect(codes('div(onclick={go})')).toContain('event-name')
    expect(codes('div(part={a + b})')).toContain('part-invalid')
    expect(codes('input(field="a")')).toContain('form-misuse')
    expect(island('Card(server="x")')).toContain('server-island-invalid')
    expect(codes('input(bind:nope={a})')).toContain('bind-misuse')
    expect(codes('slot(a="b")')).toContain('slot-invalid')
    expect(codes('div\n  head\n    title A\n')).toContain('head-invalid')
    expect(codes('svg\n  style {name}\n')).toContain('element-invalid')
    expect(codes('const Card = 1\np {Card}', 'card.kay')).toContain('name-clash')
    expect(island('Card(server)\n  @failed\n    p x')).toContain('server-island-invalid')
    expect(codes('---\n---\np.real\n@failed\n  button(onClick={() => {}}) Go\n', 'src/components/card.kay')).toContain('fallback-invalid')
    expect(found('p x').map(diagnostic => diagnostic.code)).not.toContain('template-invalid')
    expect(isErrorCode('template-invalid')).toBe(false)
  })

  it('fix an event written lowercase or with a colon, a class written twice, a part or a field written as an expression', () => {
    expect(fixed('button(onclick={go}) Go')).toBe('button(onClick={go}) Go')
    expect(fixed('button(on:click={go}) Go')).toBe('button(onClick={go}) Go')
    expect(fixed('div(class="a b" class="c") x')).toBe('div(class="a b c") x')
    expect(fixed('div(class="a"\n  id="x"\n  class="c") x')).toBe('div(class="a c"\n  id="x") x')
    expect(fixed('div.a(class) x')).toBe('div.a() x')
    expect(fixed('div(part={\'head\'}) x')).toBe('div(part="head") x')
    expect(fixed('div(style:color="red") x')).toBe('div(style:color={"red"}) x')
    expect(fixed('div(part={ \'head\' }) x')).toBe('div(part="head") x')
    expect(fixed('form(action={save})\n  input(field={\'title\'})\n')).toContain('input(field="title")')
    expect(fixed('Card(part="a a")')).toBe('Card(part="a")')
  })

  it('leave no stray comma where a fix removes an attribute from a comma-separated list', () => {
    expect(fixed('div(class="a", class="b") x')).toBe('div(class="a b") x')
    expect(fixed('div.a(class, id="x") x')).toBe('div.a(id="x") x')
    expect(fixed('div(class="a", class="b", id="x") x')).toBe('div(class="a b", id="x") x')
  })

  it('raise attribute-ineffective for an html tag setting dir', () => {
    expect(codes('head\n  html(dir="rtl")\n')).toContain('attribute-ineffective')
  })

  it('give each code flagged with a quick fix a case that produces one', () => {
    const cases: Record<string, string> = { 'event-name': 'button(onclick={go}) Go', 'duplicate-attribute': 'div(class="a" class="b")', 'attribute-invalid': 'div.a(class)', 'part-invalid': 'div(part={\'x\'})', 'form-misuse': 'form(action={save})\n  input(field={\'t\'})\n' }

    for (const [code, source] of Object.entries(cases))
      expect(found(source).find(diagnostic => diagnostic.code === code)?.fixes?.some(fix => fix.safe)).toBe(true)

    expect(Object.keys(cases).toSorted()).toEqual(Object.entries(ERRORS).filter(([, error]) => 'quickFix' in error).map(([name]) => name).toSorted())
  })

  it('leave an error without one right answer alone', () => {
    expect(fixed('div(class="a" class={b}) x')).toBe('div(class="a" class={b}) x')
    expect(fixed('div(part={a + b}) x')).toBe('div(part={a + b}) x')
    expect(fixed('div(style:color="re\'d") x')).toBe('div(style:color="re\'d") x')
  })

  it('name a quick fix only where one is made', () => {
    expect(Object.entries(ERRORS).filter(([, error]) => 'quickFix' in error).map(([name]) => name).toSorted()).toEqual(['attribute-invalid', 'duplicate-attribute', 'event-name', 'form-misuse', 'part-invalid'])
    expect(explainError('event-name')).toContain('`kay check --fix`')
    expect(explainError('name-clash')).not.toContain('`kay check --fix`')
  })
})

describe('one registry for errors and lints', () => {
  it('answers any code with its kind, group and level, and keeps the two apart', () => {
    expect(diagnosticInfo('missing-alt')).toMatchObject({ kind: 'lint', group: 'a11y', level: 'deny' })
    expect(diagnosticInfo('event-name')).toMatchObject({ kind: 'error', group: 'compile', level: undefined, quickFix: true })
    expect(diagnosticInfo('nope')).toBeUndefined()
    expect(Object.keys(LINTS).concat(Object.keys(ERRORS)).every(code => isDiagnosticCode(code))).toBe(true)
    expect(explainDiagnostic('missing-alt')).toBe(explainLint('missing-alt'))
    expect(explainDiagnostic('event-name')).toBe(explainError('event-name'))
  })
})

describe('kay explain', () => {
  it('lists the errors beside the lints, or a group\'s, and explains one with where its fix is written', async () => {
    const all = await kay(['explain'])
    const group = await kay(['explain', 'export'])
    const one = await kay(['explain', 'template-syntax'])

    expect(all.stdout).toContain('missing-alt')
    expect(all.stdout).toContain('template-syntax')
    expect(group.stdout).toBe(`${errorList('export')}\n`)
    expect(one.stdout).toBe(`${explainError('template-syntax')}\n`)
    expect(one.stdout).toContain('llms/templates.md')
  })

  it('gives the errors in its json', async () => {
    const all = JSON.parse((await kay(['explain', '--format', 'json'])).stdout) as { errors: { name: string }[], errorGroups: object }
    const one = JSON.parse((await kay(['explain', 'export-guard', '--format', 'json'])).stdout) as unknown

    expect(all.errors.map(error => error.name)).toEqual(Object.keys(ERRORS))
    expect(all.errorGroups).toEqual(ERROR_GROUPS)
    expect(one).toEqual({ name: 'export-guard', ...ERRORS['export-guard'] })
  })
})
