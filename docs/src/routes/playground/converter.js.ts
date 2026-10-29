import { respond } from '../../playground/bundle'
import { converter } from '../../playground/bundles'

// The translation of `kay fmt --from-html` for the browser, fetched by the converter box when it opens, next to the parser's WebAssembly it loads.
export async function GET({ request }: { request: Request }) {
  return respond(request, await converter(), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
}
