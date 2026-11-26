import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTranscript } from '../../../evals/lib/metrics'
import { buildEvalReport, formatEvalReport, formatGradeSummary } from '../../../evals/lib/report'
import { gradeTask } from '../../../evals/lib/verify'
import { initTaskWorkspace } from '../../../evals/lib/workspace'
import { getTask, listTasks } from '../../../evals/tasks/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs)
    rmSync(dir, { recursive: true, force: true })
})

describe('Agent Eval Suite (#3613)', () => {
  it('loads all 6 task definitions with valid prompts and metadata', () => {
    const tasks = listTasks()
    expect(tasks.length).toBe(6)

    const ids = tasks.map(t => t.spec.id)
    expect(ids).toEqual([
      '01-static-blog-i18n',
      '02-filter-island',
      '03-action-form',
      '04-auth-crud-sqlite',
      '05-streaming-regions',
      '06-mcp-tools',
    ])

    for (const task of tasks) {
      expect(task.spec.title.length).toBeGreaterThan(5)
      expect(task.spec.description.length).toBeGreaterThan(10)
      expect(['minimal', 'fullstack', 'blog', 'app']).toContain(task.spec.template)
      expect(task.spec.packages).toContain('@kayjs/kay')
      expect(task.spec.tags.length).toBeGreaterThan(0)
      expect(task.spec.maxJs).toBeDefined()
      expect(task.prompt.trim().length).toBeGreaterThan(100)
      expect(typeof task.verify).toBe('function')
    }

    expect(() => getTask('99-does-not-exist')).toThrow(/unknown task/i)
  })

  it('scaffolds a clean task workspace with @kayjs/* symlinks and llms.txt', () => {
    const dest = join(makeTemp('kay-eval-init-'), 'workspace')
    const task = getTask('01-static-blog-i18n')
    const res = initTaskWorkspace(task, dest)

    expect(res.dir).toBe(dest)
    expect(existsSync(join(dest, 'TASK.md'))).toBe(true)
    expect(existsSync(join(dest, 'kay.config.ts'))).toBe(true)
    expect(existsSync(join(dest, 'node_modules/@kayjs/kay/llms.txt'))).toBe(true)
    expect(existsSync(join(dest, 'node_modules/@kayjs/content/llms.txt'))).toBe(true)
    expect(existsSync(join(dest, 'node_modules/@kayjs/i18n/llms.txt'))).toBe(true)
    expect(existsSync(join(dest, 'node_modules/.bin/kay'))).toBe(true)

    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@kayjs/kay']).toBeDefined()
    expect(pkg.dependencies['@kayjs/content']).toBeDefined()
    expect(pkg.dependencies['@kayjs/i18n']).toBeDefined()
  })

  it('fails cleanly on an empty or broken task directory with clear diagnostics', async () => {
    const emptyDir = makeTemp('kay-eval-empty-')
    const task = getTask('02-filter-island')

    const emptyGrade = await gradeTask(task, emptyDir)
    expect(emptyGrade.ok).toBe(false)
    expect(emptyGrade.build.ok).toBe(false)
    expect(emptyGrade.assertions.some(a => !a.ok)).toBe(true)

    const brokenDir = join(makeTemp('kay-eval-broken-'), 'app')
    initTaskWorkspace(task, brokenDir)
    writeFileSync(join(brokenDir, 'src/routes/index.tsx'), `
      export default function Broken() {
        return <div dangerouslySetInnerHTML={{ __html: '<b>bad</b>' }} />
      }
    `)

    const brokenGrade = await gradeTask(task, brokenDir)
    expect(brokenGrade.ok).toBe(false)
    expect(brokenGrade.check.ok).toBe(false)
    expect(brokenGrade.check.errorCount).toBeGreaterThan(0)
    const summary = formatGradeSummary(brokenGrade)
    expect(summary).toContain('[FAIL] 02-filter-island')
    expect(summary).toContain('kay check : FAIL')
  })

  it('grades 02-filter-island end-to-end on a passing reference solution under --max-js 15kb', async () => {
    const dir = join(makeTemp('kay-eval-ref02-'), 'app')
    const task = getTask('02-filter-island')
    initTaskWorkspace(task, dir)

    mkdirSync(join(dir, 'src/components'), { recursive: true })
    writeFileSync(join(dir, 'src/components/ProductFilter.tsx'), `
import { computed, signal, useId } from '@kayjs/kay'

export interface Product {
  id: string
  name: string
  category: string
  price: number
  inStock: boolean
}

export function ProductFilter({ products }: { products: Product[] }) {
  const query = signal('')
  const category = signal('all')
  const sortBy = signal('price-asc')
  const onlyInStock = signal(false)

  const searchId = useId('search')
  const catId = useId('cat')
  const sortId = useId('sort')
  const stockId = useId('stock')

  const categories = [...new Set(products.map(p => p.category))].sort()

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    const list = products.filter((p) => {
      if (onlyInStock.value && !p.inStock)
        return false
      if (category.value !== 'all' && p.category !== category.value)
        return false
      if (q !== '' && !p.name.toLowerCase().includes(q))
        return false
      return true
    })
    return [...list].sort((a, b) => {
      if (sortBy.value === 'price-desc')
        return b.price - a.price
      if (sortBy.value === 'name')
        return a.name.localeCompare(b.name)
      return a.price - b.price
    })
  })

  return (
    <section>
      <div>
        <label for={searchId}>Search</label>
        <input
          id={searchId}
          type="search"
          value={query.value}
          onInput={(e: Event) => { query.value = (e.currentTarget as HTMLInputElement).value }}
        />

        <label for={catId}>Category</label>
        <select
          id={catId}
          value={category.value}
          onChange={(e: Event) => { category.value = (e.currentTarget as HTMLSelectElement).value }}
        >
          <option value="all">All</option>
          {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
        </select>

        <label for={sortId}>Sort</label>
        <select
          id={sortId}
          value={sortBy.value}
          onChange={(e: Event) => { sortBy.value = (e.currentTarget as HTMLSelectElement).value }}
        >
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
          <option value="name">Name A-Z</option>
        </select>

        <label for={stockId}>In stock only</label>
        <input
          id={stockId}
          type="checkbox"
          checked={onlyInStock.value}
          onChange={(e: Event) => { onlyInStock.value = (e.currentTarget as HTMLInputElement).checked }}
        />
      </div>

      <p>{filtered.value.length} products</p>
      {filtered.value.length === 0
        ? <p>No products match your filters.</p>
        : (
            <ul>
              {filtered.value.map(p => (
                <li key={p.id}>
                  <strong>{p.name}</strong> — {p.category} — \${p.price}
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
`)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
import type { PageProps } from '@kayjs/kay'
import type { Product } from '../components/ProductFilter'
import { Head } from '@kayjs/kay'
import { ProductFilter } from '../components/ProductFilter'

export async function load() {
  const products: Product[] = [
    { id: '1', name: 'Mechanical Keyboard', category: 'Hardware', price: 149, inStock: true },
    { id: '2', name: 'USB-C Dock', category: 'Hardware', price: 89, inStock: true },
    { id: '3', name: 'Ergonomic Chair', category: 'Furniture', price: 499, inStock: false },
    { id: '4', name: 'Standing Desk', category: 'Furniture', price: 649, inStock: true },
    { id: '5', name: 'Noise Canceling Headphones', category: 'Audio', price: 299, inStock: true },
    { id: '6', name: 'Studio Microphone', category: 'Audio', price: 129, inStock: false },
  ]
  return { products }
}

export default function CatalogPage({ data }: PageProps<typeof load>) {
  return (
    <main>
      <Head><title>Product Catalog</title></Head>
      <h1>Product Catalog</h1>
      <ProductFilter products={data.products} />
    </main>
  )
}
`)

    const grade = await gradeTask(task, dir)
    expect(grade.check.ok).toBe(true)
    expect(grade.build.ok).toBe(true)
    expect(grade.build.maxEagerJsBytes).toBeGreaterThan(0)
    expect(grade.build.maxEagerJsBytes).toBeLessThanOrEqual(15 * 1024)
    expect(grade.assertions.every(a => a.ok)).toBe(true)
    expect(grade.ok).toBe(true)
  }, 30000)

  it('grades 03-action-form end-to-end on a passing reference solution with useAction, flash fallback, and testApp tests', async () => {
    const dir = join(makeTemp('kay-eval-ref03-'), 'app')
    const task = getTask('03-action-form')
    initTaskWorkspace(task, dir)

    mkdirSync(join(dir, 'src/actions'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'tests'), { recursive: true })

    writeFileSync(join(dir, 'src/actions/feedback.ts'), `
import type { StandardSchemaV1 } from '@kayjs/kay/server'
import { action } from '@kayjs/kay/server'

export interface FeedbackInput {
  name: string
  email: string
  message: string
}

const feedbackSchema: StandardSchemaV1<unknown, FeedbackInput> = {
  '~standard': {
    version: 1,
    vendor: 'eval-ref',
    validate(value) {
      const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      const name = typeof obj.name === 'string' ? obj.name.trim() : ''
      const email = typeof obj.email === 'string' ? obj.email.trim() : ''
      const message = typeof obj.message === 'string' ? obj.message.trim() : ''
      const issues: Array<{ message: string, path: string[] }> = []

      if (name.length < 2)
        issues.push({ message: 'Name must be at least 2 characters', path: ['name'] })
      if (!email.includes('@') || !email.includes('.'))
        issues.push({ message: 'Please enter a valid email address', path: ['email'] })
      if (message.length < 10)
        issues.push({ message: 'Message must be at least 10 characters', path: ['message'] })

      if (issues.length > 0)
        return { issues }
      return { value: { name, email, message } }
    },
  },
}

export const submitFeedback = action(feedbackSchema, async (input) => {
  return {
    id: crypto.randomUUID(),
    name: input.name,
    email: input.email,
    receivedAt: new Date().toISOString(),
  }
})
`)

    writeFileSync(join(dir, 'src/components/FeedbackForm.tsx'), `
import { useAction } from '@kayjs/kay'
import { submitFeedback } from '../actions/feedback'

export interface FeedbackFormProps {
  serverError?: string
  serverFieldErrors?: Record<string, string>
}

export function FeedbackForm({ serverError, serverFieldErrors }: FeedbackFormProps) {
  const form = useAction(submitFeedback, { reset: true })
  const fieldErr = (field: string): string | undefined =>
    form.fieldErrors.value[field] ?? serverFieldErrors?.[field]
  const topError = () => form.error.value ?? serverError

  return (
    <form action={form.action} method="post" onSubmit={form.onSubmit}>
      {topError() && <p role="alert">{topError()}</p>}
      <div>
        <label for="fb-name">Name</label>
        <input id="fb-name" name="name" type="text" required />
        {fieldErr('name') && <p role="alert">{fieldErr('name')}</p>}
      </div>
      <div>
        <label for="fb-email">Email</label>
        <input id="fb-email" name="email" type="email" required />
        {fieldErr('email') && <p role="alert">{fieldErr('email')}</p>}
      </div>
      <div>
        <label for="fb-message">Message</label>
        <textarea id="fb-message" name="message" required />
        {fieldErr('message') && <p role="alert">{fieldErr('message')}</p>}
      </div>
      <button type="submit" disabled={form.pending.value}>Send feedback</button>
      {form.data.value && <p>Thanks {form.data.value.name}, received!</p>}
    </form>
  )
}
`)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
import type { PageProps, RouteContext } from '@kayjs/kay'
import { Head } from '@kayjs/kay'
import { getActionError } from '@kayjs/kay/server'
import { FeedbackForm } from '../components/FeedbackForm'

export async function load(ctx: RouteContext) {
  const flash = getActionError(ctx.locals)
  return {
    serverError: flash?.error,
    serverFieldErrors: flash?.fieldErrors,
  }
}

export default function FeedbackPage({ data }: PageProps<typeof load>) {
  return (
    <main>
      <Head><title>Send Feedback</title></Head>
      <h1>Feedback</h1>
      <FeedbackForm
        serverError={data.serverError}
        serverFieldErrors={data.serverFieldErrors}
      />
    </main>
  )
}
`)

    writeFileSync(join(dir, 'tests/feedback.test.ts'), `
import type { ServerAction } from '@kayjs/kay/server'
import { expect, test } from 'bun:test'
import { testApp } from '@kayjs/kay/test'

test('rejects invalid input with fieldErrors and accepts valid submission', async () => {
  const app = await testApp({ root: '.' })
  const mod = await app.import('src/actions/feedback.ts')
  const submitFeedback = mod.submitFeedback as ServerAction<never, unknown>

  const bad = await app.post(submitFeedback.url, { name: 'A', email: 'bad', message: 'hi' })
  expect(bad.status).toBe(400)
  const badBody = await bad.json() as { ok: boolean, fieldErrors?: Record<string, string> }
  expect(badBody.ok).toBe(false)
  expect(badBody.fieldErrors?.email).toBeDefined()

  const good = await app.post(submitFeedback.url, {
    name: 'Jane Doe',
    email: 'jane@example.com',
    message: 'Loving kay v2 progressive actions!',
  })
  expect(good.status).toBe(200)
  const goodBody = await good.json() as { ok: boolean, data?: { name: string } }
  expect(goodBody.ok).toBe(true)
  expect(goodBody.data?.name).toBe('Jane Doe')
})
`)

    const grade = await gradeTask(task, dir)
    expect(grade.check.ok).toBe(true)
    expect(grade.build.ok).toBe(true)
    expect(grade.build.maxEagerJsBytes).toBeGreaterThan(0)
    expect(grade.build.maxEagerJsBytes).toBeLessThanOrEqual(15 * 1024)
    expect(grade.tests.ran).toBe(true)
    expect(grade.tests.ok).toBe(true)
    expect(grade.assertions.every(a => a.ok)).toBe(true)
    expect(grade.ok).toBe(true)
  }, 30000)

  it('parses normalized & Claude JSONL transcripts for friction metrics and formats the summary report', () => {
    const normalizedTranscript = [
      JSON.stringify({ type: 'turn', role: 'assistant' }),
      JSON.stringify({ type: 'tool_call', tool: 'read_file', args: { path: 'node_modules/@kayjs/kay/llms.txt' } }),
      JSON.stringify({ type: 'tool_call', tool: 'read_file', args: { path: 'node_modules/@kayjs/kay/src/server/action.ts' } }),
      JSON.stringify({
        type: 'tool_result',
        command: 'kay check',
        exitCode: 1,
        output: 'src/routes/index.tsx:12:5: error: kay compiler: signal read without .value in src/routes/index.tsx: read count.value.',
      }),
      JSON.stringify({ type: 'turn', role: 'assistant' }),
      JSON.stringify({ type: 'tool_call', tool: 'run_command', args: { command: 'cat node_modules/@kayjs/spa/src/regions.ts' } }),
      JSON.stringify({
        type: 'tool_result',
        command: 'kay check',
        exitCode: 1,
        output: 'src/components/Form.tsx:20:3: error: kay compiler: signal read without .value in src/components/Form.tsx: read count.value.',
      }),
      JSON.stringify({ type: 'turn', role: 'assistant' }),
      JSON.stringify({ type: 'grade', ok: true }),
    ].join('\n')

    const m = parseTranscript(normalizedTranscript)
    expect(m.formatDetected).toBe('normalized')
    expect(m.totalTurns).toBe(3)
    expect(m.turnsToGreen).toBe(3)
    expect(m.llmsReads.count).toBe(1)
    expect(m.llmsReads.files).toEqual(['node_modules/@kayjs/kay/llms.txt'])
    expect(m.sourceReads.count).toBe(2)
    expect(m.sourceReads.files).toEqual([
      'node_modules/@kayjs/kay/src/server/action.ts',
      'node_modules/@kayjs/spa/src/regions.ts',
    ])
    expect(m.repeatedFailures.length).toBe(1)
    expect(m.repeatedFailures[0]?.count).toBe(2)
    expect(m.repeatedFailures[0]?.category).toContain('kay-compiler:')

    // Also verify Claude Code JSONL format
    const claudeTranscript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'node_modules/@kayjs/mcp/llms.txt' } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'node_modules/@kayjs/mcp/src/index.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', is_error: true, content: 'kay check: missing default export in src/routes/index.tsx' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kay build' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', is_error: true, content: 'kay check: missing default export in src/routes/other.tsx' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kay build' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', is_error: false, content: 'kay build done in 42.1 ms (2 routes, 1 client assets, 0 actions)' },
          ],
        },
      }),
    ].join('\n')

    const cm = parseTranscript(claudeTranscript)
    expect(cm.formatDetected).toBe('claude-jsonl')
    expect(cm.totalTurns).toBe(3)
    expect(cm.turnsToGreen).toBe(3)
    expect(cm.llmsReads.count).toBe(1)
    expect(cm.sourceReads.count).toBe(1)
    expect(cm.repeatedFailures.length).toBe(1)
    expect(cm.repeatedFailures[0]?.category).toContain('kay-check:')

    // Format compact Markdown report
    const report = buildEvalReport([
      {
        taskId: '02-filter-island',
        title: 'Interactive Product Filter & Sort Island',
        dir: '/tmp/02',
        ok: true,
        durationMs: 420,
        maxJs: '15kb',
        maxJsBytes: 15360,
        check: { ok: true, checkedFiles: 3, errorCount: 0, warningCount: 0, errors: [], warnings: [] },
        build: { ok: true, maxEagerJsBytes: 3450, routeWeights: [{ path: '/', jsGzip: 3450, cssGzip: 0, firstLoad: 3450, islands: 1 }], budgetExceeded: false },
        tests: { ran: false, ok: true, exitCode: 0, output: '' },
        assertions: [{ name: 'renders catalog', ok: true }],
        metrics: m,
      },
      {
        taskId: '06-mcp-tools',
        title: 'Typed MCP Tools',
        dir: '/tmp/06',
        ok: false,
        durationMs: 310,
        maxJs: '15kb',
        maxJsBytes: 15360,
        check: { ok: false, checkedFiles: 2, errorCount: 1, warningCount: 0, errors: [{ severity: 'error', message: 'over budget' }], warnings: [] },
        build: { ok: true, maxEagerJsBytes: 0, routeWeights: [], budgetExceeded: false },
        tests: { ran: false, ok: true, exitCode: 0, output: '' },
        assertions: [{ name: 'auth 401', ok: false, detail: 'got 200' }],
        metrics: cm,
      },
    ])

    const md = formatEvalReport(report)
    expect(md).toContain('# Kay v2 Agent Eval Report')
    expect(md).toContain('**1/2 passed**')
    expect(md).toContain('`02-filter-island`')
    expect(md).toContain('PASS')
    expect(md).toContain('FAIL')
    expect(md).toContain('node_modules/@kayjs/kay/src/server/action.ts')
    expect(md).toContain('stalled 2x')
  })
})
