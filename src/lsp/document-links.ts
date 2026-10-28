import type { Span } from '../compiler/ast'
import type { Route } from '../server/routes'
import type { LspHost, Project } from './host'
import type { DocumentLink } from './protocol'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveFrom } from '../build/files'
import { projectRootOf } from '../project'
import { scanRoutes } from '../server/routes'
import { clientUri } from './bridge'
import { remembered } from './host'
import { toPosition } from './positions'
import { importSpecifiers } from './renames'
import { mentionsRoute, routeLinks } from './route-links'

// The files a relative import names, and the pages the route paths written in the text lead to, so the editor opens them from the specifier or the path.
export async function links(host: LspHost, uri: string): Promise<DocumentLink[]> {
  const document = host.documents.get(uri)

  if (!document)
    return []

  const range = (span: Span) => ({ start: toPosition(document.source, span.start), end: toPosition(document.source, span.end) })
  const imports = importSpecifiers(document.source).flatMap((span) => {
    const specifier = document.source.slice(span.start, span.end)
    const target = specifier.startsWith('.') ? resolveFrom(specifier, document.file) : undefined

    return target === undefined ? [] : [{ range: range(span), target: clientUri(host, target) }]
  })
  const project = host.projectAt(projectRootOf(document.file, host.root))
  // The route table is read from disk, so a text with no route path asks for none.
  const routes = mentionsRoute(document.source) ? await routeTable(project) : []
  const own = new Set(routes.some(route => route.matchers) ? await ownMatchers(project) : [])

  return [...imports, ...routeLinks(document.source, routes, project.locales, own).map(link => ({ range: range(link), target: clientUri(host, link.file) }))]
}

// The matchers the project writes in `src/params`, which shadow the ones kay ships.
export async function ownMatchers(project: Project): Promise<string[]> {
  try {
    return await remembered(project.lookups, 'ownMatchers', async () => (await readdir(join(project.routesDir, '..', 'params'))).filter(name => name.endsWith('.ts')).map(name => name.slice(0, -3)))
  }
  catch {
    return []
  }
}

// The pages of the project, none while its route files are ones the router refuses, which `kay check` reports itself.
export async function routeTable(project: Project): Promise<Route[]> {
  try {
    return await remembered(project.lookups, 'routes', async () => scanRoutes(project.routesDir, project.mounts))
  }
  catch {
    return []
  }
}
