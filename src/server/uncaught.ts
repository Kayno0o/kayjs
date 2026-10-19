import type { Elysia as App } from 'elysia'
import type { KayConfig } from '../config'
import type { RequestContext } from './render'
import { kayLog } from '../runtime/log'
import { describeError, sharedContext } from './render'
import { isUncaught, reportServerError } from './report'

const TEXT = 'text/plain; charset=utf-8'

const HTML_REQUEST = /text\/html/

// A browser asking for a page gets the page-less 500 the app's `_error.kay` or kay's own error page draws, as for any other server error on a page; any other request gets plain text.
function asksForPage(request: Request): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && HTML_REQUEST.test(request.headers.get('accept') ?? '')
}

// Answers an error no route caught, thrown by an `onRequest` hook, a param matcher, `rewrite` or an extension's hook, as a 500 that is logged and handed to `onError`.
// Without it Elysia answers 200 with the error's message in production; a `Response` thrown on purpose is answered as given, and any `onError` of the app's own, registered earlier, answers first.
// The handler destructures what it reads: Elysia takes one handed the whole context for a reader of the body and parses every body for it.
export function answerUncaught(app: App, { dev, onError, page }: { dev: boolean, onError: KayConfig['onError'], page: (error: unknown, context: RequestContext) => Promise<Response> }): void {
  app.onError({ as: 'global' }, async ({ request, error, code }) => {
    if (error instanceof Response)
      return error

    if (!isUncaught(error, code))
      return undefined

    reportServerError(error, request, onError)

    if (asksForPage(request)) {
      try {
        return await page(error, sharedContext(request, () => ({ request })))
      }
      // A page that cannot render without the route it would have matched falls back to the plain answer.
      catch (failure) {
        kayLog('error', 'the error page failed', failure)
      }
    }

    return new Response(dev ? describeError(error, true).message : 'Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
  })
}
