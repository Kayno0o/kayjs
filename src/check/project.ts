// What `kay check` finds across the project beside each file's compile and type errors, shared with the editor, which reports it on save.
import type { Subprocess } from 'bun'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintLevels } from '../compiler/lints'
import type { I18nConfig, KayExtension } from '../config'
import type { CollectionFeed, ComponentUse } from '../content/server'
import type { ContentProblem } from '../content/validate'
import type { ShadowTypes } from './shadow-types'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { findProjectFiles, writeIfChanged } from '../build/files'
import { moduleChecks } from '../compiler/fence-checks'
import { isLaunchLint, isLint, isLintGroup, LEVELS, lintLevels } from '../compiler/lints'
import { CONFIG_FILE } from '../config'
import { FEEDS_MARKER, PROBLEMS_MARKER, USES_MARKER } from '../content/server'
import { projectPaths } from '../project'
import { bootProblems } from './boot'
import { CONTENT_CHECK, contentPropsCheck } from './generated'
import { FILES_MARKER, stampOf } from './loaded'
import { configSeoLints } from './seo'
import { fromCompile } from './shadow-types'

// The project's own scripts, which `kay check` reads for what only it reports in them; a declaration file holds no code.
const SCRIPT_MODULE = /\.(?:[cm]?ts|tsx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const CONTENT_PROBLEMS = fileURLToPath(new URL('../content/problems.ts', import.meta.url))
const MESSAGE_PROBLEMS = fileURLToPath(new URL('./messages.ts', import.meta.url))
// Reading a big site's collections takes seconds; past this, the code they run is waiting on something that never comes.
const PROBE_TIMEOUT = 60_000
// The checking scripts running, which the editor's language server stops when it exits.
const probes = new Set<Subprocess>()
// An unknown property, and a value of the wrong type, with or without a suggestion.
const LINT_TYPE_ERRORS = new Set(['TS2353', 'TS2322', 'TS2820'])

// What a checking script last found, with the files it read and where they were: the script runs again only when its arguments or one of those files changed. The editor keeps one per project, by script.
export type ProbeMemory = Map<string, { args: string, files: string[], stamp: string, result: ProbeResult }>

type ProbeResult = { marked: <Value>(marker: string) => Value | undefined } | { failed: string }

// A file written this close to the script starting may have been read before or after the write, so a result is remembered only when every file it read is older.
const STAMP_MARGIN = 100

// The collections as read, and the props their Markdown entries give components, written for tsgo to type with the rest.
export interface ContentChecks {
  problems: CheckDiagnostic[]
  feeds: CollectionFeed[]
  props: Map<number, ComponentUse>
}

// The collections read, in a process of their own, and the props their entries give components written to the module tsgo types them in.
export async function contentChecks(root: string, options: CheckOptions, memory?: ProbeMemory): Promise<ContentChecks> {
  const content = await checkContent(root, options.content, options.site !== undefined, memory)
  const props = contentPropsCheck(resolve(root), projectPaths(root, options).content, content.uses)

  await writeIfChanged(join(projectPaths(root).types, CONTENT_CHECK), props.code)

  return { problems: content.problems, feeds: content.feeds, props: props.lines }
}

// What the shadow tree's write and the config tell, reported ahead of the type errors.
export function configProblems(root: string, options: CheckOptions, types: ShadowTypes): CheckDiagnostic[] {
  const seo = configSeoLints(options, join(root, CONFIG_FILE), [...types.files.values()].map(file => file.source), options.exported === true)

  return [...types.problems, ...lintConfigProblems(root, options.lints), ...seo.filter(diagnostic => options.launch === true || !isLaunchLint(diagnostic.code))]
}

// The collections, the messages, what the server refuses when it boots and the lints of the project's scripts, reported after the type errors.
export async function projectProblems(root: string, options: CheckOptions, content: ContentChecks, memory?: ProbeMemory): Promise<CheckDiagnostic[]> {
  const [messages, boot, modules] = await Promise.all([checkMessages(root, options.i18n, options.extensions, memory), bootProblems(resolve(root), options, content.feeds), moduleLints(root, options.lints)])

  return [...content.problems, ...messages, ...boot, ...modules]
}

// A type error tsgo reports in `kay.config.ts` for a lint or level `lints` names that kay does not have, which kay's own message says better.
export function lintConfigTypeError(root: string, lints: Record<string, string> = {}, diagnostic: CheckDiagnostic): boolean {
  if (diagnostic.file !== join(root, CONFIG_FILE) || !LINT_TYPE_ERRORS.has(diagnostic.code ?? ''))
    return false

  return Object.entries(lints).some(([name, level]) => !isLint(name) && !isLintGroup(name) ? diagnostic.message.includes(`'${name}'`) : !LEVELS.has(level) && diagnostic.message.includes(`"${level}"`))
}

// The lints the compiler finds in fences, in the project's own scripts: the schema builder imported as `t`, and a stylesheet imported for a value with no text attribute.
async function moduleLints(root: string, levels: LintLevels | undefined): Promise<CheckDiagnostic[]> {
  const files = (await findProjectFiles(root, SCRIPT_MODULE, { project: true, ownKayOnly: true })).filter(file => !DECLARATION_FILE.test(file))
  const found = await Promise.all(files.map(async (file) => {
    const source = await Bun.file(file).text()
    const levelAt = lintLevels(source, levels)

    return moduleChecks(source).flatMap((diagnostic) => {
      const level = isLint(diagnostic.code) ? levelAt(diagnostic.code, diagnostic.start) : 'deny'

      return level === 'allow' ? [] : [fromCompile(file, source, { ...diagnostic, severity: level === 'warn' ? 'warning' : 'error' })]
    })
  }))

  return found.flat()
}

// What a checking script printed on the lines it marked, whatever else the project's code logged, run in a process of its own so an edited file is read afresh; the reason it failed otherwise.
// With a `memory`, the last result stands while the arguments and every file the script listed as read are as they were.
export async function probe(root: string, script: string, args: string[], reading: string, memory?: ProbeMemory, timeout = PROBE_TIMEOUT): Promise<ProbeResult> {
  const key = JSON.stringify(args)
  const remembered = memory?.get(script)

  if (remembered && remembered.args === key && stampOf(remembered.files).stamp === remembered.stamp)
    return remembered.result

  const started = Date.now()
  const child = Bun.spawn([process.execPath, script, resolve(root), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout })

  probes.add(child)

  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  probes.delete(child)
  memory?.delete(script)

  if (child.signalCode !== null)
    return { failed: `${reading} did not finish within ${timeout / 1000} s and was stopped: the code it runs waits on something that never comes` }

  if (code !== 0)
    return { failed: errors.trim() || `${reading} exited with code ${code}` }

  const lines = output.split('\n')
  const result: ProbeResult = {
    marked: <Value>(marker: string) => {
      const line = lines.find(text => text.startsWith(marker))

      return line === undefined ? undefined : JSON.parse(line.slice(marker.length)) as Value
    },
  }
  const listed = lines.find(text => text.startsWith(FILES_MARKER))

  if (memory && listed !== undefined) {
    const files = JSON.parse(listed.slice(FILES_MARKER.length)) as string[]
    const { stamp, newest } = stampOf(files)

    if (newest < started - STAMP_MARGIN)
      memory.set(script, { args: key, files, stamp, result })
  }

  return result
}

export function stopProbes(): void {
  for (const child of probes)
    child.kill()
}

function problemsOf(root: string, problems: ContentProblem[] = []): CheckDiagnostic[] {
  return problems.map(problem => ({ file: resolve(root, problem.file), line: problem.line, column: 1, message: problem.message }))
}

// Each locale's messages against the default locale's.
async function checkMessages(root: string, config: I18nConfig | undefined, extensions: KayExtension[] = [], memory?: ProbeMemory): Promise<CheckDiagnostic[]> {
  if (!config)
    return []

  const read = await probe(root, MESSAGE_PROBLEMS, [JSON.stringify(config), JSON.stringify(extensions.map(({ name, messages }) => ({ name, messages })))], 'reading the messages', memory)

  if ('failed' in read)
    return [{ file: join(root, CONFIG_FILE), line: 1, column: 1, message: read.failed }]

  return problemsOf(root, read.marked(PROBLEMS_MARKER))
}

// The collections' entries that fail to compile or to match their schema, the components their entries use and the feeds they serve.
export async function checkContent(root: string, config: string | undefined, site: boolean, memory?: ProbeMemory): Promise<{ problems: CheckDiagnostic[], uses: ComponentUse[], feeds: CollectionFeed[] }> {
  if (config === undefined && !existsSync(projectPaths(root).content))
    return { problems: [], uses: [], feeds: [] }

  const read = await probe(root, CONTENT_PROBLEMS, [config ?? '', site ? 'site' : ''], 'reading the collections', memory)

  if ('failed' in read)
    return { problems: [{ file: projectPaths(root, { content: config }).content, line: 1, column: 1, message: read.failed }], uses: [], feeds: [] }

  return { problems: problemsOf(root, read.marked(PROBLEMS_MARKER)), uses: read.marked(USES_MARKER) ?? [], feeds: read.marked(FEEDS_MARKER) ?? [] }
}

// A lint or a level `lints` names that kay does not have, which would otherwise pass unnoticed.
function lintConfigProblems(root: string, lints: Record<string, string> = {}): CheckDiagnostic[] {
  const at = { file: join(root, CONFIG_FILE), line: 1, column: 1 }

  return Object.entries(lints).flatMap(([name, level]) => {
    if (!isLint(name) && !isLintGroup(name))
      return [{ ...at, message: `\`lints\` names \`${name}\`, which is no lint or group`, help: '`kay explain` lists them' }]

    return LEVELS.has(level) ? [] : [{ ...at, message: `The ${isLint(name) ? 'lint' : 'group'} \`${name}\` is set to \`${level}\`, which is no level`, help: 'set it to `allow`, `warn` or `deny`' }]
  })
}
