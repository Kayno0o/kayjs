import type { Document, LspHost } from './host'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { routeShadowPath } from '../check/route-shadow'
import { routeShadowOf } from '../check/shadow-types'
import { projectRootOf } from '../project'

// A plain TypeScript file the editor opens, which may be an endpoint or an API module; a declaration file and a shadow kay writes are not.
export const ROUTE_CANDIDATE = /^file:.*(?<!\.d|\.kay)\.ts$/

// An open endpoint or API module as a document: its shadow, typed from the file tree as `kay check` types it, stands for the file in tsgo. Undefined when the project's last shadow write knows it as neither, or nothing in it is typed from the file tree.
export function routeDocument(host: LspHost, uri: string, text: string, version: number): Document | undefined {
  const file = fileURLToPath(uri)
  const root = projectRootOf(file, host.root)
  const served = host.projects.get(root)?.types?.served
  const shadow = served && routeShadowOf(root, served, file, text)

  if (!shadow)
    return undefined

  return { ...shadow, uri, shadowUri: pathToFileURL(routeShadowPath(root, file)).href, version, diagnostics: [], insideIsland: false, signals: '[]', queries: '[]', slots: '[]', guards: '[]' }
}
