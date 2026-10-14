// The modules kay writes for tsgo to check what only types tell, each line of one standing for the file it is about, and the type errors tsgo reports there taken back to that file.
import type { CheckDiagnostic } from '.'
import type { SettingsReplacement } from '../build/libraries'
import type { ComponentUse } from '../content/server'
import type { ApiModule } from '../server/api'
import type { Endpoint, Route } from '../server/routes'
import type { ContentChecks } from './project'
import type { ShadowTypes } from './shadow-types'
import { join, relative, resolve } from 'node:path'
import { SCRIPT_FILE, settingsReplacements } from '../build/libraries'
import { CONFIG_FILE } from '../config'
import { projectPaths } from '../project'
import { matcherSource } from './shadow'

export const SETTINGS_CHECK = 'kay-settings.ts'
export const EXPORTS_CHECK = 'kay-exports.ts'
export const CONTENT_CHECK = 'kay-content.ts'
// A prop name TypeScript reads unquoted, so its errors name it as written.
const IDENTIFIER = /^[a-z_$][\w$]*$/i

// A generated module and what each of its lines stands for, by the line number tsgo reports.
export interface Assertions<About> {
  code: string
  lines: Map<number, About>
}

// A line of a generated module, with what it stands for when a type error there is about a file of the user's.
type AssertionLine<About> = string | { code: string, about: About }

// The module the lines make, each one standing for something numbered as tsgo counts lines, from 1; no module at all without a line standing for something.
function assertions<About>(lines: AssertionLine<About>[]): Assertions<About> {
  const about = new Map<number, About>()
  const code = lines.map((line, index) => {
    if (typeof line === 'string')
      return line

    about.set(index + 1, line.about)

    return line.code
  })

  return { code: about.size === 0 ? '' : `${code.join('\n')}\n`, lines: about }
}

function modulePath(root: string, file: string): string {
  return JSON.stringify(relative(projectPaths(root).types, file).replace(SCRIPT_FILE, ''))
}

// One line per library whose settings the app replaces, assigning the app's module to the type of the defaults it stands in for.
export function settingsCheck(root: string, settings: Record<string, string>, diagnostics: CheckDiagnostic[]): Assertions<{ file: string, library: string }> {
  let replacements: SettingsReplacement[]

  try {
    replacements = settingsReplacements(root, settings)
  }
  catch (error) {
    diagnostics.push({ file: join(root, CONFIG_FILE), line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })
    replacements = []
  }

  return assertions([
    ...replacements.flatMap(({ defaults, replacement }, index) => [`import type defaults${index} from ${modulePath(root, defaults)}`, `import settings${index} from ${modulePath(root, replacement)}`]),
    '',
    ...replacements.map(({ library, replacement }, index) => ({ code: `export const kaySettings${index}: typeof defaults${index} = settings${index}`, about: { file: replacement, library } })),
  ])
}

// Each default export the server calls, a guard's, an API module's or a matcher's, assigned to the type it is called as, so a wrong one is a type error at its file rather than a refusal at boot.
export function exportsCheck(root: string, routesDir: string, routes: Route[], api: ApiModule[], endpoints: Endpoint[]): Assertions<{ file: string, wanted: string }> {
  const guards = new Set([...routes, ...api, ...endpoints].flatMap(served => served.guards.map(guard => guard.file)))
  const matchers = new Set(routes.flatMap(route => Object.values(route.matchers ?? {})).map(matcher => matcherSource(routesDir, matcher)).filter((source): source is string => source !== undefined && source !== 'kay'))
  const entries: { file: string, type: string, wanted: string, named?: string }[] = [
    ...[...guards].map(file => ({ file, type: 'Guard', wanted: 'a guard by default: export default guard(ctx => ...)' })),
    ...api.map(module => ({ file: module.file, type: 'AnyElysia', wanted: 'an Elysia instance by default: export default new Elysia().get(\'/\', () => ...)' })),
    ...[...matchers].map(file => ({ file, type: '(value: string) => unknown', wanted: 'a matcher by default: export default (value: string) => value or undefined' })),
    // Its context is the app's to type, `EndpointContext<{ slug: string }>`; what it returns is checked.
    ...endpoints.map(endpoint => ({ file: endpoint.file, type: '(ctx: never) => EndpointBody | Promise<EndpointBody>', wanted: 'a GET handler: export function GET(ctx: EndpointContext) { return \'text\' }', named: 'GET' })),
  ]
  const kayTypes = [...guards.size > 0 ? ['Guard'] : [], ...endpoints.length > 0 ? ['EndpointBody'] : []]

  // An import that finds no such export is reported at the import, a wrong one at its check.
  return assertions([
    ...kayTypes.length > 0 ? [`import type { ${kayTypes.join(', ')} } from 'kay'`] : [],
    ...api.length > 0 ? ['import type { AnyElysia } from \'elysia\''] : [],
    ...entries.map(({ file, wanted, named }, index) => ({ code: `import ${named === undefined ? `kayExport${index}` : `{ ${named} as kayExport${index} }`} from ${modulePath(root, file)}`, about: { file, wanted } })),
    '',
    ...entries.map(({ file, wanted, type }, index) => ({ code: `export const kayCheck${index}: ${type} = kayExport${index}`, about: { file, wanted } })),
  ])
}

// One line per component a Markdown entry uses, its props assigned to the type the component takes, so one missing, misspelt or of the wrong type is a type error at the entry's line.
export function contentPropsCheck(root: string, configFile: string, uses: ComponentUse[]): Assertions<ComponentUse> {
  return assertions([
    `import type * as kayContent from ${modulePath(root, configFile)}`,
    '',
    'type KayPropsOf<Component> = Component extends (props: infer Props) => unknown ? Props : never',
    '',
    // What a component wraps reaches it as `children`, which one taking none is then reported for.
    ...uses.map((use, index) => {
      const props = [...Object.entries(use.props).map(([name, value]) => `${IDENTIFIER.test(name) ? name : JSON.stringify(name)}: ${JSON.stringify(value)}`), ...use.children ? ['children: undefined as never'] : []]

      return { code: `export const kayProps${index}: KayPropsOf<(typeof kayContent)[${JSON.stringify(use.collection)}]['components'][${JSON.stringify(use.component)}]> = { ${props.join(', ')} }`, about: use }
    }),
  ])
}

// The modules kay writes for tsgo to check what only types tell: the settings libraries take, what guards, API modules and matchers export, and the props entries give components.
export function generatedChecks(root: string): string[] {
  const shadowDir = projectPaths(root).types

  return [SETTINGS_CHECK, EXPORTS_CHECK, CONTENT_CHECK].map(name => join(shadowDir, name))
}

// A type error in a module `generatedChecks` names, at the file and line the user wrote what it is about; undefined for any other.
export function generatedProblem(root: string, diagnostic: CheckDiagnostic, types: ShadowTypes, content: ContentChecks): CheckDiagnostic | undefined {
  const [settingsFile, exportsFile, contentFile] = generatedChecks(root)
  const { file, line, code, message } = diagnostic
  const setting = file === settingsFile ? types.settings.get(line) : undefined
  const exported = file === exportsFile ? types.exports.get(line) : undefined
  const used = file === contentFile ? content.props.get(line) : undefined

  if (setting)
    return { file: setting.file, line: 1, column: 1, code, message: `The settings for ${setting.library} do not match what it takes: ${message}` }

  if (exported)
    return { file: exported.file, line: 1, column: 1, code, message: `It must export ${exported.wanted}: ${message}` }

  return used && { file: resolve(root, used.file), line: used.line, column: 1, code, message: `<${used.component}> takes other props: ${message}` }
}
