import type { ErrorName } from '../src/compiler/errors'
import { join } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { KayCompileError, transformKay } from '../src/build/transform'
import { failureProblem } from '../src/commands/command'
import { compileKay } from '../src/compiler'
import { buildFailure, ERROR_GROUPS, errorCodeOf, errorList, ERRORS, explainError, isErrorCode, KayError, raisedMark } from '../src/compiler/errors'
import { LINTS } from '../src/compiler/lints'
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
  const files = [...new Glob('src/**/*.ts').scanSync({ cwd: root })].filter(file => file !== 'src/compiler/errors.ts' && !file.includes('/codec/'))

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
    // Raised while serving a request, in the dev tool, the editor, `kay new` or the test helpers: no code, as docs say.
    const uncoded = new Set(['src/dev/inspector.ts', 'src/dev/tailwind.ts', 'src/lsp/server.ts', 'src/new.ts', 'src/server/actions.ts', 'src/server/api.ts', 'src/server/avif.ts', 'src/server/card-draw.ts', 'src/server/crop.ts', 'src/server/i18n.ts', 'src/server/image-format.ts', 'src/server/lifecycle.ts', 'src/server/loader.ts', 'src/server/queue.ts', 'src/server/session.ts', 'src/server/signals.ts'])
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

  it('are listed in llms/checks.md and the docs reference, with a link to the fix', async () => {
    const llms = await Bun.file(join(root, 'llms/checks.md')).text()
    const docs = await Bun.file(join(root, 'docs/src/content/docs/reference/checks.md')).text()

    expect(Object.keys(ERRORS).filter(name => !llms.includes(`| \`${name}\` | ${ERRORS[name as keyof typeof ERRORS].group} |`))).toEqual([])
    expect(Object.keys(ERRORS).filter(name => !docs.includes(`| \`${name}\` | ${ERRORS[name as keyof typeof ERRORS].group} |`))).toEqual([])

    for (const error of Object.values(ERRORS)) {
      const anchor = error.fix.heading.toLowerCase().replaceAll('`', '').replace(SLUG_PUNCTUATION, '').trim().replaceAll(' ', '-')

      expect(llms).toContain(`[${error.fix.heading}](${error.fix.file.replace('llms/', '')}#${anchor})`)
    }
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
    expect(codes('head\n  title A\nhead\n  title B\n')).toContain('template-invalid')
    expect(codes('---\nconst { a } = props<{ a: string }>()\nconst { b } = props<{ b: string }>()\n---\np {a}\n')).toContain('fence-invalid')
    expect(codes('--- client\nconst n = 1\n---\np {n}\n', 'src/routes/_layout.kay')).toContain('client-route-fence')
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
