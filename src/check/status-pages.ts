import type { CheckDiagnostic, CheckOptions } from '.'
import type { ServedProject } from './shadow-types'
import { dirname, relative, sep } from 'node:path'
import { findProjectFiles } from '../build/files'
import { STATUS_PAGE_FILES } from '../compiler/status-pages'
import { projectPaths } from '../project'

const STATUS_PAGE = new RegExp(`^(?:${[...STATUS_PAGE_FILES].map(name => name.replace('.', '\\.')).join('|')})$`)

// A status page (`_401.kay`, `_403.kay`, `_429.kay`, `_503.kay`) renders for the routes of its directory and below, so one in a directory with no route is never rendered.
export async function unusedStatusPages(root: string, options: CheckOptions, { routes }: ServedProject): Promise<CheckDiagnostic[]> {
  const routesDir = projectPaths(root, options).routes
  const files = (await findProjectFiles(root, STATUS_PAGE, { project: true, ownOnly: true })).filter(file => !relative(routesDir, file).startsWith('..'))

  return files.filter(file => !routes.some(route => route.file.startsWith(dirname(file) + sep))).map(file => ({
    file,
    line: 1,
    column: 1,
    severity: 'warning',
    message: `\`${relative(routesDir, file)}\` is in a directory with no route, so no page renders it`,
    help: 'move it to the directory of the pages it answers for, or delete it',
  }))
}
