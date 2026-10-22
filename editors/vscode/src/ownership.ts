import type { Middleware } from 'vscode-languageclient/node'
import { owns } from './roots'

// The middleware hooks that take a document first: provideHover(document, position, token, next).
const FEATURE = /^(?:provide|prepare)/

type Next = (...args: never[]) => unknown

// Keeps the documents of a deeper project away from the server of `root`, whose selector is a folder and so matches the nested project too; `served` is every root with a server, nested ones included, read at each call.
export function ownedBy(root: string, served: () => string[]): Middleware {
  const mine = (target: unknown): boolean => {
    const uri = typeof target === 'object' && target !== null && 'uri' in target ? target.uri : target
    const path = typeof uri === 'object' && uri !== null && 'fsPath' in uri && typeof uri.fsPath === 'string' ? uri.fsPath : undefined

    return path === undefined || owns(root, path, served())
  }
  // The client chains `.catch` on a notification hook and hands `willSaveWaitUntil` to `waitUntil`, so each answers a promise even when it passes nothing on.
  const notify = async (document: unknown, next: Next): Promise<void> => mine(document) ? next(document as never) as Promise<void> : undefined
  const handlers: Record<string, unknown> = {
    didOpen: notify,
    didClose: notify,
    didSave: notify,
    didChange: async (event: { document: unknown }, next: Next) => mine(event.document) ? next(event as never) : undefined,
    willSave: async (event: { document: unknown }, next: Next) => mine(event.document) ? next(event as never) : undefined,
    willSaveWaitUntil: async (event: { document: unknown }, next: Next) => mine(event.document) ? next(event as never) : [],
    handleDiagnostics: (uri: unknown, diagnostics: unknown, next: Next) => mine(uri) ? next(uri as never, diagnostics as never) : undefined,
  }

  return new Proxy(handlers, {
    get(target, name) {
      if (typeof name !== 'string')
        return undefined

      if (Object.hasOwn(target, name))
        return target[name]

      if (!FEATURE.test(name))
        return undefined

      return (...args: unknown[]) => {
        const next = args.pop() as (...rest: unknown[]) => unknown

        return mine(args[0]) ? next(...args) : undefined
      }
    },
  }) as Middleware
}
