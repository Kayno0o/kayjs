import { recordOf } from './request-record'

// The `Server-Timing` value of what an action, an endpoint or an API route measured: its guards and its handler, none when `serverTiming` is off.
export function handlerTiming(request: Request): string | undefined {
  const guards = recordOf(request)?.guardsTook
  const handler = recordOf(request)?.handlerTook

  if (guards === undefined && handler === undefined)
    return undefined

  return [...guards === undefined ? [] : [`guards;dur=${guards.toFixed(1)}`], ...handler === undefined ? [] : [`handler;dur=${handler.toFixed(1)}`]].join(', ')
}
