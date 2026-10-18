import type { Elysia as App } from 'elysia'
import type { KayConfig } from '../config'
import { errorPageScripts } from './dev'
import { errorPage } from './overlay'
import { describeError } from './render'
import { reportServerError } from './report'

const HTML = 'text/html; charset=utf-8'
const TEXT = 'text/plain; charset=utf-8'

// Elysia names the errors it means to answer itself; a hook or route that threw anything else reaches the catch-all with `UNKNOWN`, or with no code at all from an `onRequest` hook.
function isUncaught(code: unknown): boolean {
  return code === undefined || code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR'
}

// Answers an error no route caught, thrown by an `onRequest` hook, a param matcher, `rewrite` or an extension's hook, as a 500 that is logged and handed to `onError`.
// Without it Elysia answers 200 with the error's message in production; a `Response` thrown on purpose is answered as given, and any `onError` of the app's own, registered earlier, answers first.
export function answerUncaught(app: App, { dev, onError }: { dev: boolean, onError: KayConfig['onError'] }): void {
  app.onError({ as: 'global' }, ({ request, error, code }) => {
    if (!isUncaught(code) || error instanceof Response)
      return error instanceof Response ? error : undefined

    reportServerError(error, request, onError)

    if (dev && (request.headers.get('accept') ?? '').includes('text/html'))
      return new Response(errorPage(describeError(error, true)) + errorPageScripts(), { status: 500, headers: { 'content-type': HTML } })

    return new Response(dev ? describeError(error, true).message : 'Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
  })
}
