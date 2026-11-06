import type { MissingPath, MissingStore, NotFoundHome } from './not-found'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isCrossSite } from './actions'
import { appDatabase } from './app-database'
import { answeredBy, notFoundHome, openMissing } from './not-found'
import { addRedirect, checkRedirect } from './not-found-config'
import { notFoundTablesExist } from './pg-not-found'

const HEADER = 'x-kay-dev'

// What the dev tool's Not found tab lists: the paths a production run recorded visitors found nothing at, the ones a redirect of the config answers left out.
export interface DevNotFound {
  // The file a production run keeps them in, from the project's root.
  file: string
  // Whether that file exists: `kay dev` records nothing itself.
  recorded: boolean
  missing: MissingPath[]
}

const PG_TABLE = 'kay_missing'

// What the dev server opens: the log's SQLite file when it exists, or its Postgres tables when the database already holds them, as `kay dev` creates neither.
async function recordedHome(root: string): Promise<{ home: NotFoundHome, shown: string } | { shown: string, home?: undefined }> {
  const home = notFoundHome(appDatabase(), root)

  if (home.kind === 'pg')
    return await notFoundTablesExist(home.source) ? { home, shown: PG_TABLE } : { shown: PG_TABLE }

  return existsSync(home.file) ? { home, shown: relative(root, home.file) } : { shown: relative(root, home.file) }
}

export async function devNotFound(root: string, redirects: string[]): Promise<DevNotFound> {
  const { home, shown } = await recordedHome(root)

  if (home === undefined)
    return { file: shown, recorded: false, missing: [] }

  const store = openMissing(home, false, true)
  const answered = answeredBy(redirects)

  try {
    return { file: shown, recorded: true, missing: (await store.list()).filter(row => !answered(row.path)) }
  }
  finally {
    await store.close()
  }
}

function refused(error: string, status = 400): Response {
  return Response.json({ error }, { status })
}

// Writes the redirect `kay not-found --redirect` would, from a click on the tab: `path`, and `to` or else the target recorded for it.
export async function devRedirect(root: string, request: Request, redirects: string[]): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  let body: { path?: unknown, to?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return refused('the request holds no JSON')
  }

  if (typeof body.path !== 'string' || (body.to !== undefined && typeof body.to !== 'string'))
    return refused('path and to are texts')

  const { home } = await recordedHome(root)
  const store: MissingStore | undefined = home === undefined ? undefined : openMissing(home, false, true)

  try {
    const redirect = body.path
    const target = body.to ?? (await store?.list())?.find(row => row.path === redirect)?.target

    if (target === undefined)
      return refused(`${redirect} has no suggested target`)

    checkRedirect(redirect, target, new Set(redirects))

    if (await addRedirect(join(root, 'kay.config.ts'), redirect, target) === 'by hand')
      return refused('kay.config.ts has no `redirects` object literal to add the redirect to: add it by hand')

    await store?.forget(redirect)

    return Response.json({ redirect: { from: redirect, to: target } })
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  finally {
    await store?.close()
  }
}
