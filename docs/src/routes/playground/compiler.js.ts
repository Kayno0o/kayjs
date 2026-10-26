import { respond } from '../../playground/bundle'
import { compiler } from '../../playground/bundles'

// kay's compiler for the browser, fetched by the playground page when it opens: a docs page that never opens the playground loads none of it.
export async function GET({ request }: { request: Request }) {
  return respond(request, await compiler(), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
}
