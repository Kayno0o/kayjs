import type { Program } from '../compiler/estree'
import type { ApiModule } from '../server/api-modules'
import type { ApiScope } from './api-scope'
import { parseProgram } from '../compiler/estree'
import { apiScope } from './api-scope'

export interface ParsedApi {
  file: string
  source: string
  ast: Program
  scope: ApiScope
}

const NODE_MODULES = /[\\/]node_modules[\\/]/
// One parse of a project's API modules for every check reading their routes.
const parsed = new WeakMap<ApiModule[], Promise<ParsedApi[]>>()

async function parseModules(modules: ApiModule[]): Promise<ParsedApi[]> {
  const read = await Promise.all(modules.filter(module => !NODE_MODULES.test(module.file)).map(async module => ({ file: module.file, source: await Bun.file(module.file).text() })))
  const found: ParsedApi[] = []

  for (const { file, source } of read) {
    try {
      const { program: ast, errors } = parseProgram(source, { recover: true })

      // A fatal error leaves an empty program, which is no module that parsed.
      if (errors.length > 0 && ast.body.length === 0)
        continue

      found.push({ file, source, ast, scope: apiScope(ast) })
    }
    catch {}
  }

  return found
}

// The API modules of the project itself, read and parsed once per list, the ones that do not parse left out.
export async function parsedApiModules(modules: ApiModule[]): Promise<ParsedApi[]> {
  let found = parsed.get(modules)

  if (found === undefined) {
    found = parseModules(modules)
    parsed.set(modules, found)
  }

  return found
}
