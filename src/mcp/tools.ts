import type { Content, Resource, Tool, ToolResult } from './protocol'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { KAY_DIR } from '../build/assets'
import { isLintGroup, LINT_GROUPS } from '../compiler/lints'
import { MAX_HEIGHT, MAX_WIDTH, MIN_SIZE } from '../dev/screenshot-limits'
import { DEV_ERRORS_FILE } from '../server/dev-errors'

const CLI = join(import.meta.dir, '..', 'cli.ts')
const KAY_ROOT = join(import.meta.dir, '..', '..')
const LLMS_DIR = join(KAY_ROOT, 'llms')
const DEV_ERRORS = join(KAY_DIR, 'dev', DEV_ERRORS_FILE)
// A page or a check running longer is cut short, as a model waiting on it would be.
const CALL_TIMEOUT_MS = 5 * 60_000
// What a result keeps of a stream, so that a huge page does not fill the model's context.
const MAX_OUTPUT = 512 * 1024
// How long a child gets to stop on SIGTERM before it is killed.
const STOP_WAIT_MS = 2000
const SCHEME = /^https?:\/\//
const CONTENT_TYPE = /^content-type:\s*([^;\s]+)/im
// A body read as text: a `text/` type, or one of the structured formats that are text, `+json` and `+xml` suffixes included.
const TEXT_TYPE = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|.+\+(?:json|xml)))/i
const HEADING = /^(#{1,2}) (.+)$/gm
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

// The commands running for a call.
const children = new Set<Bun.Subprocess>()
// The calls of this project, one after the other: they share its `.kay`, and each `render` boots the whole app.
let queue = Promise.resolve()
// Set once the commands are stopped for good, so that a call still waiting its turn does not start one.
let stopped = false

interface Run {
  code: number
  stdout: string
  // What the command wrote to stdout as it wrote it, which `stdout` reads as text; a page that is no text is these bytes.
  body: Uint8Array
  // The body was cut at the limit, which for bytes that are no text makes them useless.
  truncated: boolean
  stderr: string
}

// The tools and resources of the project at `root`, which is where each tool's `kay` command runs.
export async function projectCapabilities(root: string): Promise<{ tools: Tool[], resources: Resource[] }> {
  return { tools: tools(root), resources: await resources() }
}

function tools(root: string): Tool[] {
  const kay = async (args: string[]) => run(root, args)
  const document = async (args: string[]) => jsonResult(await kay(args))

  return [
    {
      name: 'check',
      title: 'Check the project',
      description: 'Type-checks the project, .kay files and templates included, and lints it. Answers `{ errors, warnings, problems }`, each problem with its file, line, column, severity, code and message. Give `paths` to report only on those files or directories; the project is still checked as a whole. A problem is a result, not a failure of the tool.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories in the project to report on, relative to the project root; `.` is the whole project.' },
          only: { type: 'string', enum: Object.keys(LINT_GROUPS), description: 'Report one group of lints alone, such as `seo`.' },
          denyWarnings: { type: 'boolean', description: 'Count warnings as failures. The report is the same.' },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: async (args) => {
        const given = stringList(args.paths, 'paths').map(path => insideProject(root, path))
        // The project root among the paths is the whole report.
        const paths = given.includes('') ? [] : given
        const only = optionalString(args.only, 'only')

        if (only !== undefined && !isLintGroup(only))
          throw new Error(`only takes a group of lints, ${Object.keys(LINT_GROUPS).join(', ')}`)

        return document(['check', ...only === undefined ? [] : [`--only=${only}`], ...args.denyWarnings === true ? ['--deny-warnings'] : [], '--format', 'json', ...paths.length === 0 ? [] : ['--', root, ...paths]])
      },
    },
    {
      name: 'routes',
      title: 'List the routes',
      description: 'Lists every route the project serves, without running a page: `{ routes, unlisted }`, each route with its methods, path, kind (page, action, endpoint, api, plugin, redirect, feed or kay), the file serving it, and its layouts and guards, outermost first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      run: async () => document(['routes', '--format', 'json']),
    },
    {
      name: 'explain',
      title: 'Explain a lint or an error code',
      description: 'Without a name, lists the lints and the error codes kay raises with their groups and summaries. With the name of a lint, a lint group, an error code or an error group, explains it: for a lint an example it reports and the same written right, for an error code where its fix is written in the guide.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'A lint such as `missing-alt`, an error code, or a group of either.' } }, additionalProperties: false },
      annotations: READ_ONLY,
      run: async (args) => {
        const name = optionalString(args.name, 'name')

        return document(['explain', '--format', 'json', ...name === undefined ? [] : ['--', name]])
      },
    },
    {
      name: 'render',
      title: 'Render a URL',
      description: 'Answers one request as the app\'s server would under `kay dev`, without starting it on a port, and returns the body, then the status line, the headers and what the server logged. A status of 400 or above is an error result that still carries the body. Boots the whole app: a POST runs its action against the app\'s database.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A path such as `/about`, or an http URL.' },
          method: { type: 'string', description: 'The HTTP method; GET, or POST when a body is given.' },
          body: { type: 'string', description: 'The request body, sent as a form unless a content-type header says otherwise.' },
          headers: { type: 'array', items: { type: 'string' }, description: 'Request headers, each as `name: value`.' },
          cookies: { type: 'array', items: { type: 'string' }, description: 'Cookies, each as `name=value`, such as a session cookie for a guarded page.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const { url } = args
        const method = optionalString(args.method, 'method')
        const body = optionalString(args.body, 'body')

        // A value that began with `-` would be read as an option.
        if (typeof url !== 'string' || !(url.startsWith('/') || SCHEME.test(url)))
          throw new Error('url takes a path such as /about or an http URL')

        const result = await kay(['render', url, '--include', ...method === undefined ? [] : [`--method=${method}`], ...body === undefined ? [] : [`--body=${body}`], ...stringList(args.headers, 'headers').map(header => `--header=${header}`), ...stringList(args.cookies, 'cookies').map(cookie => `--cookie=${cookie}`)])

        const status: Content = { type: 'text', text: `kay render exited ${result.code}\n${result.stderr}`.trim() }

        return { content: [renderedBody(result), status], isError: result.code !== 0 }
      },
    },
    {
      name: 'screenshot',
      title: 'Screenshot a page',
      description: 'Shoots a page of the running `kay dev` server in a headless Chrome and returns PNGs, to see what the HTML does not tell: a control off screen at phone width, a stacked table, the dark scheme. By default two shots, 375 and 1280 px wide. Answers `{ url, status, shots, console, problems }` first, then an image per shot: `console` holds the page\'s console errors and why it did not settle, `problems` what `kay dev` listed for the page. Each shot is kept in `.kay/screenshots/` with the one before it, and `diff: true` adds an image of what changed since that one (changed pixels red) - shoot, edit, shoot again to check the edit moved only what it meant to. Needs `kay dev` running and Chrome or Chromium (`BUN_CHROME_PATH`).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The page\'s path as a visitor types it, such as `/admin/posts` or `/fr/about?page=2`; a site\'s `base` is added when missing. Only pages of the dev server are shot.' },
          width: { type: 'integer', minimum: MIN_SIZE, maximum: MAX_WIDTH, description: 'The window\'s width in pixels, for one shot instead of the 375 and 1280 pair.' },
          height: { type: 'integer', minimum: MIN_SIZE, maximum: MAX_HEIGHT, description: 'The window\'s height in pixels, 800 by default.' },
          scheme: { type: 'string', enum: ['light', 'dark'], description: 'The colour scheme the page is asked for, light by default.' },
          fullPage: { type: 'boolean', description: `The whole page rather than the window, cut at ${MAX_HEIGHT} px.` },
          cookies: { type: 'array', items: { type: 'string' }, description: 'Cookies as `name=value` the page is opened with, to shoot a page behind a session.' },
          diff: { type: 'boolean', description: 'Add the diff image against the previous shot of the same page, width and scheme, when there is one.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (args) => {
        const { path } = args

        // A value that began with `-` would be read as an option.
        if (typeof path !== 'string' || !path.startsWith('/'))
          throw new Error('path takes a path such as /about')

        const numbers = (['width', 'height'] as const).flatMap((name) => {
          const value = args[name]

          if (value === undefined)
            return []

          if (typeof value !== 'number' || !Number.isInteger(value))
            throw new Error(`${name} takes a whole number of pixels`)

          return [`--${name}=${value}`]
        })
        const scheme = optionalString(args.scheme, 'scheme')
        const result = await kay(['screenshot', path, '--format', 'json', ...numbers, ...scheme === undefined ? [] : [`--scheme=${scheme}`], ...args.fullPage === true ? ['--full-page'] : [], ...stringList(args.cookies, 'cookies').map(cookie => `--cookie=${cookie}`)])

        if (result.code !== 0)
          return { content: [{ type: 'text', text: result.stderr.trim() || `kay screenshot exited ${result.code}` }], isError: true }

        const report = JSON.parse(result.stdout) as { shots: { file: string, diff?: { file: string } }[] }
        const images: Content[] = []

        for (const shot of report.shots) {
          for (const file of [shot.file, ...args.diff === true && shot.diff !== undefined ? [shot.diff.file] : []])
            images.push({ type: 'image', data: (await Bun.file(join(root, file)).bytes()).toBase64(), mimeType: 'image/png' })
        }

        return { content: [{ type: 'text', text: result.stdout.trim() }, ...images], structuredContent: report }
      },
    },
    {
      name: 'dev_errors',
      title: 'Read the dev server\'s errors',
      description: 'Reads the errors a running `kay dev` met, from `.kay/dev/errors.json`: why the server failed to boot, requests that threw and errors islands met in the browser, each with its message, report and where the project\'s own code threw. An error leaves the list once the file compiles or the request answers again. Answers an empty list when `kay dev` has met none or has not run.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      run: async () => {
        const file = Bun.file(join(root, DEV_ERRORS))

        if (!await file.exists())
          return jsonText({ errors: [], note: `${DEV_ERRORS} does not exist: \`kay dev\` has not run in this project, or has met no error since.` })

        try {
          const document: unknown = await file.json()

          if (typeof document !== 'object' || document === null || Array.isArray(document))
            throw new Error('Not a JSON object')

          return jsonText(document)
        }
        catch {
          return { content: [{ type: 'text', text: `${DEV_ERRORS} is not valid JSON; \`kay dev\` may be writing it, call again.` }], isError: true }
        }
      },
    },
  ]
}

// The llms/ files, which hold the guide to each part of kay, and the index that links them.
async function resources(): Promise<Resource[]> {
  const files = (await readdir(LLMS_DIR)).filter(name => name.endsWith('.md')).toSorted()
  const index: Resource = {
    uri: 'kay://llms.txt',
    name: 'llms.txt',
    title: 'kay: start here',
    description: 'The rules easy to get wrong and links to the guide of each part of kay. Read it first.',
    mimeType: 'text/markdown',
    read: async () => Bun.file(join(KAY_ROOT, 'llms.txt')).text(),
  }

  return [index, ...await Promise.all(files.map(async (name) => {
    const path = join(LLMS_DIR, name)
    const text = await Bun.file(path).text()
    const headings = [...text.matchAll(HEADING)].map(match => ({ level: match[1]!.length, title: match[2]! }))
    const title = headings.find(heading => heading.level === 1)?.title ?? name

    return {
      uri: `kay://llms/${name}`,
      name,
      title,
      description: `Sections: ${headings.filter(heading => heading.level === 2).map(heading => heading.title).join(', ')}`,
      mimeType: 'text/markdown',
      read: async () => Bun.file(path).text(),
    } satisfies Resource
  }))]
}

// Runs `kay` with `args` in `root`, as a child so that what a command prints, exits with or throws cannot reach the protocol on this process's stdout.
// One call at a time: the next waits for the one before, a failed call included, and its timeout starts when it does.
// A screenshot only reads the running `kay dev` and writes its own files, so it goes beside the others rather than make them wait up to a minute.
async function run(root: string, args: string[]): Promise<Run> {
  if (args[0] === 'screenshot')
    return spawnKay(root, args)

  const before = queue
  let done!: () => void

  queue = new Promise<void>((resolve) => {
    done = resolve
  })

  await before

  try {
    return await spawnKay(root, args)
  }
  finally {
    done()
  }
}

async function spawnKay(root: string, args: string[]): Promise<Run> {
  if (stopped)
    return { code: 1, stdout: '', body: new Uint8Array(), truncated: false, stderr: `kay ${args[0]} did not run: kay mcp is stopping` }

  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, detached: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stop(child)
  }, CALL_TIMEOUT_MS)

  children.add(child)

  try {
    const [out, stderr] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text()])
    const code = await child.exited
    const truncated = out.length > MAX_OUTPUT
    const body = truncated ? out.subarray(0, MAX_OUTPUT) : out

    if (timedOut)
      return { code, stdout: '', body: new Uint8Array(), truncated: false, stderr: `kay ${args[0]} was stopped after ${CALL_TIMEOUT_MS / 1000} s` }

    return { code, stdout: truncated ? `${new TextDecoder().decode(body)}\n[truncated at ${MAX_OUTPUT} bytes]` : new TextDecoder().decode(body), body, truncated, stderr: truncate(stderr) }
  }
  finally {
    clearTimeout(timer)
    children.delete(child)
  }
}

// The body of a render as the page's type calls for: text as text, an image as an image, any other bytes as a blob, none of them passed through a text decoder, which would replace what it cannot read.
function renderedBody(result: Run): Content {
  const type = CONTENT_TYPE.exec(result.stderr)?.[1]?.toLowerCase()

  if (type === undefined || TEXT_TYPE.test(type) || result.body.length === 0)
    return { type: 'text', text: result.stdout }

  if (result.truncated)
    return { type: 'text', text: `[the ${type} body is over ${MAX_OUTPUT} bytes and is not returned]` }

  const data = result.body.toBase64()

  return type.startsWith('image/') && type !== 'image/svg+xml' ? { type: 'image', data, mimeType: type } : { type: 'resource', resource: { uri: 'kay://render/body', mimeType: type, blob: data } }
}

// Stops every command still running, as the client going away or a call abandoned leaves no one to read its answer; `now` kills them at once, for a process about to exit, which no later escalation would outlive.
export function stopChildren(now = false): void {
  stopped = true

  for (const child of children) {
    if (now)
      signalGroup(child, 'SIGKILL')
    else
      stop(child)
  }
}

// SIGTERM first, so the command cleans up after itself, then SIGKILL for what does not stop.
function stop(child: Bun.Subprocess): void {
  signalGroup(child, 'SIGTERM')
  setTimeout(signalGroup, STOP_WAIT_MS, child, 'SIGKILL').unref()
}

// A command runs in a process group of its own, so what it started, such as the server of a render or the type checker of a check, stops with it whether or not the command forwards the signal.
function signalGroup(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal)
  }
  catch {
    // The group ended meanwhile.
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated at ${MAX_OUTPUT} characters]` : text
}

// A command under `--format json` leaves one document on stdout whatever its exit code, a problem found included; one that could not run also says why on stderr, and without a document nothing ran.
function jsonResult({ code, stdout, stderr }: Run): ToolResult {
  let document: object

  try {
    document = JSON.parse(stdout) as object
  }
  catch {
    return { content: [{ type: 'text', text: stderr.trim() || stdout.trim() || 'The command printed nothing.' }], isError: true }
  }

  const result = jsonText(document)

  if (stderr.trim() === '')
    return result

  // What the command says besides its document, such as a warning, goes beside it; a command that could not run says why on stderr and prints that as its document's problem, which a check finding is never.
  const { problems } = document as { problems?: { message?: unknown }[] }
  const failed = code !== 0 && (!Array.isArray(problems) || problems.length === 0 || problems.some(problem => typeof problem.message === 'string' && stderr.includes(problem.message)))

  return { ...result, content: [...result.content, { type: 'text', text: stderr.trim() }], ...failed && { isError: true } }
}

function jsonText(document: object): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(document) }], structuredContent: document }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined)
    return undefined

  if (typeof value !== 'string')
    throw new Error(`${name} takes a string`)

  return value
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined)
    return []

  if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
    throw new Error(`${name} takes a list of strings`)

  return value as string[]
}

// A path in the project, relative to its root, so that `check` is never pointed outside it; the root itself is the empty string.
function insideProject(root: string, path: string): string {
  const absolute = resolve(root, path)
  const inside = relative(root, absolute)

  if (isAbsolute(inside) || inside.split(sep)[0] === '..')
    throw new Error(`${path} is not a file or directory inside the project`)

  if (!existsSync(absolute))
    throw new Error(`${path} does not exist`)

  return inside
}
