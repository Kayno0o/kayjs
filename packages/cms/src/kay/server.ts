import type { PageContext, RouteParams } from 'kay'

// From kaynooo/kayjs#262, to come from `kay/server`.

// Whether the request was let into edit mode, by a guard or the preview secret.
export function editRequested(_request: Request): boolean {
  throw new Error('kay does not ship editRequested() yet (kaynooo/kayjs#262)')
}

// `enterPreview` with `edit`, which kay ships without it today.
export function enterPreview(_ctx: Pick<PageContext<RouteParams>, 'cookies'>, _options: { edit: true }): void {
  throw new Error('kay does not ship enterPreview(ctx, { edit: true }) yet (kaynooo/kayjs#262)')
}
