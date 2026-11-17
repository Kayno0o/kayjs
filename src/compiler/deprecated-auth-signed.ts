import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'
import { rename } from './deprecated-ui-props'

type Report = (span: Span, message: string, details: Details) => void

// kayjs-auth's `SignedIn(role=...)`, `require` since 1.105 as the guard's option is, and `SignedOut`, the `@else` block of `SignedIn` since 1.105. Found on a component bound to the library's file; `role` is renamed unless `require` is written beside it, and `SignedOut` is reported with no fix, as it joins the `SignedIn` beside it by hand.
export function deprecatedAuthSigned(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  if (file === 'auth/signed-out') {
    report(element.tag, '`SignedOut` is the `@else` block of `SignedIn` since 1.105: `SignedIn` with its children for a signed-in user and an `@else` block for a visitor, one component for the one check', { help: 'Write the children as an `@else` block of a `SignedIn`' })

    return
  }

  if (file !== 'auth/signed-in')
    return

  const attributes = element.attributes.filter((attribute): attribute is Named => attribute.kind !== 'spread')
  const role = attributes.find(attribute => text(attribute.name) === 'role')

  if (role === undefined)
    return

  const message = '`role` of `SignedIn` is `require` since 1.105, which takes what `auth.guard({ require })` does: a role, a list of which any one passes, or a predicate'

  report(role.name, message, attributes.some(attribute => text(attribute.name) === 'require')
    ? { help: 'Drop `role`, `require` is there' }
    : { help: 'Write `require`', fixes: [{ title: 'Write `require`', edits: [rename(role, 'role', 'require')], safe: true }] })
}
