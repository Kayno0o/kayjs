import type { CheckDiagnostic, CheckOptions } from '.'
import type { ServedProject } from './shadow-types'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { exportedNames, strayExports } from '../server/endpoint-verbs'

const NODE_MODULES = /[\\/]node_modules[\\/]/
const IDENTIFIER_CHAR = /[\w$]/

// Where the name first stands as a whole identifier, not inside a longer one.
function firstUse(source: string, name: string): number {
  for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + 1)) {
    if (!IDENTIFIER_CHAR.test(source[at - 1] ?? '') && !IDENTIFIER_CHAR.test(source[at + name.length] ?? ''))
      return at
  }

  return 0
}

// The exports of an endpoint file the server never calls: a name that is no method, with the method it was probably meant to be when only its case differs.
export async function endpointExports(options: CheckOptions, { endpoints }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('endpoint-export', options.lints)

  if (level === 'allow')
    return []

  const found = await Promise.all(endpoints.filter(({ file }) => !NODE_MODULES.test(file)).map(async ({ file }) => {
    const source = await Bun.file(file).text()

    return strayExports(exportedNames(source)).map(({ name, meant }): CheckDiagnostic => ({
      file,
      ...positionAt(source, firstUse(source, name)),
      code: 'endpoint-export',
      severity: level === 'warn' ? 'warning' : 'error',
      message: `\`${name}\` is exported by an endpoint file but is no method, so the server never calls it`,
      help: meant === undefined ? 'export a handler as GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS, in capitals' : `rename it \`${meant}\``,
    }))
  }))

  return found.flat()
}
