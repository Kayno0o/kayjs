// From kaynooo/kayjs#262, to come from `kay/server`: whether the request was let into edit mode, by a guard or the preview secret.
export function editRequested(_request: Request): boolean {
  throw new Error('kay does not ship editRequested() yet (kaynooo/kayjs#262)')
}
