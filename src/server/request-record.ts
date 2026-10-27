import type { Server } from 'bun'
import type { Elysia } from 'elysia'
import type { ProxyConfig } from '../config'

// What kay's hooks note of a request as it arrives, one record per request rather than one table per fact, each fact set only by the feature that reads it.
export interface RequestRecord {
  // The server it came through, for `clientAddress` called where only the request is at hand, as in a guard.
  server?: Server<unknown>
  // The `proxy` setting of the app it reached, undefined for one setting none.
  proxy?: ProxyConfig | undefined
  // The app that received it, which serves an action a library calls as a tool when no server does; held weakly, so an app nothing reaches any more goes.
  app?: WeakRef<Elysia>
  // Its id, drawn on first read or passed on by a trusted proxy or a rewrite.
  id?: string
}

const records = new WeakMap<Request, RequestRecord>()

// The record of a request, made on first use.
export function requestRecord(request: Request): RequestRecord {
  let record = records.get(request)

  if (record === undefined)
    records.set(request, record = {})

  return record
}

// The record of a request, if a hook made one.
export function recordOf(request: Request): RequestRecord | undefined {
  return records.get(request)
}
