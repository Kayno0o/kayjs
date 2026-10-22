# kayjs-auth: Sessions and guards

## Common tasks

### Guards and gates

A `_guard.ts` default-exports kayjs-auth's guard, `guard({ redirect, require, scope })` from the package, which asks the request's `auth`, so imports no module (`auth.guard()` is the same):

```ts
import { guard } from '@kaynooo/kayjs-auth'

export default guard({ redirect: '/login', require: 'editor' })
```

Plain Elysia routes, such as an API, close behind a gate:

```ts
const api = new Elysia({ prefix: '/api' })
  .use(auth.gate())
  .get('/me', ({ auth }) => auth.user())
  .get('/stats', () => stats(), { auth: 'admin' })
  .get('/health', () => 'ok', { auth: false })
```

## Reference

### Sessions

Each sign-in is kept on the user's list of sessions in the store, whatever holds the session itself, so one can be ended from another browser:

- `listSessions()` lists `{ id, current, device, userAgent, ip, place, createdAt, lastSeenAt }`, oldest first, `current` the browser asking. `device` is the user agent read as `{ browser, os, mobile }`, such as `Firefox` and `Windows`, `null` for what it does not know. `place` is what `locate(ip)` answers, an option of the app's over a geolocation database of its own, `null` without one or when it throws. A visit is recorded at most every five minutes, or at once from a new address.
- `revokeSession(id)` ends one of them, effective on that browser's next request; ending the current one signs out. It answers `{ ok: true }`, or `{ ok: false, error: 'not-found' }` when the user has no session with that id (`signed-out` through a bearer token). `endSession(id)`, answering a boolean, is its old name.
- The lifetimes are the `session()` plugin's own, read from it with nothing to repeat: a session unseen for its `maxAge` is over even when its cookie lives on, and one signed in its `absoluteMaxAge` ago is over however often it was seen, "remember me" included. The cookie and the list agree, as both follow the plugin. Only `remember.maxAge` is kayjs-auth's, a duration (seconds or `'90d'`), 90 days by default.
- "Remember me": `remember: true` keeps the session `remember.maxAge` unseen; `remember: false` gives it a cookie the browser drops on closing, over after the plugin's `browserMaxAge` unseen. Without `remember` the session takes the plugin's `maxAge`, whatever a sign-in before chose in that browser. It goes in the trailing options object of `signInWithPassword(input, { remember })`, `register(input, { remember })`, `requestMagicLink(email, { remember })` (for the link opened, or the code typed, in that browser), `signInWithPasskey(response, { remember })` and `signIn(user, { remember })`, or as `?remember=1` or `?remember=0` on an OAuth link, and holds through the second factor.
- A change to how the account is signed in to ends the user's other sessions, which leave the list, and every bearer token, this browser staying signed in: a password changed or reset, the second factor turned on or off, new recovery codes, a passkey removed, a provider unlinked, a new address confirmed. So does `signOutEverywhere`.
- Through a bearer token, `listSessions()` is empty and `revokeSession` ends nothing: the list belongs to the browsers.
- `sessionsPage`, such as `/account/sessions`, is where the app lists them: `new-sign-in` mails link to it, so a user who does not know the sign-in can end it.
- A sign-in from before the list existed goes on it at its next request.
- Every sign-in of a person (a guest excepted) sets the readable cookie `kay_user`, `Path=/`, `SameSite=Lax`, `Secure` exactly when the session cookie is, a new random value each time, `Max-Age` as long as the session can last (`absoluteMaxAge`) and a session cookie for `remember: false`; a sign-out, or a session found over, clears it. It is a hint for a script of the site, never read by the server and never a permission: kayjs-cms's script asks its guard when it sees it, so an editor sees the Edit this page link at once. Set on the response of the sign-in or sign-out, a route's own `Response` included.

### Guard and gate rules

- An anonymous GET or HEAD that may be a page opening goes to `redirect`, with where they were going as `?redirect=`, a path to hand to `signInWithPassword` or an OAuth link. Without `redirect`, the pages' sign-in page or the `signInPage` of `createAuth` is used; without any, and for any post, the answer is a 401. A user who does not meet `require` gets a 403.
- A requirement is a role, a predicate `(user, ctx) => boolean`, or a list of which any one passes. A role includes the roles `roles` lists under it: with `{ admin: ['editor'], editor: [] }`, an admin meets `'editor'`. A user's roles are `UserRecord.roles` in the store. `defaultRoles: ['user']` gives every new user those roles, by password or by provider; a store leaves them to kayjs-auth rather than filling them in itself, so it knows which roles were given on purpose.
- `auth.hasRole('admin')` is the predicate form, `auth.isGranted('admin', user)` the plain check.
- The pieces `createAuth` builds these from are exported for an app with its own principal: `createRoleHierarchy(hierarchy, user => user.roles)` gives `{ isGranted, hasRole }`, `createGate({ principal, authorize, defaultRequirement, scopes?, defaultScope? })` is the Elysia plugin behind `auth.gate()`, and `scopeAllows(tokenScopes, wanted)` says whether a bearer token's scopes meet a route's `scope:`, true for a session (`null`) and `false` as `wanted`. The types of a requirement are `Requirement<User, Grant>` (a grant, `{ type, resourceId }`, a `Predicate<User>` or a list), `Predicate`, `PolicyContext` (the `params`, `body` and `query` a predicate may read), `Principal`, `Level` and `RoleHierarchy`.
- `authorize: (user, requirement, level, ctx) => Promise<boolean>` replaces the decision, for grants on single records: `decide(grantStore, user, requirement, level, ctx)` reads a `GrantStore` of the app's. `level` is `'read'` for GET and HEAD, `'write'` otherwise.

- Every route the instance declares after `.use(auth.gate())` needs a signed-in user, or `gate({ require })`'s requirement. A route asks for more with `auth: <requirement>` and stays open with `auth: false`. Routes added through `group`, `guard`, `route`, `all`, `ws` or a used plugin are closed too, so a route that forgets `auth:` stays closed. A route declared before the gate stays open: use the gate first.
- `auth.gate()` brings `auth.plugin` along, so `auth` reaches the routes declared after the gate's instance too.
- Gates nest: a sub-router behind `auth.gate({ require: 'admin' })` inside an app behind `auth.gate()` needs both. A route's `auth:` and `scope:` change only the gate nearest it, so `auth: false` or a looser requirement in the sub-router still meets every gate around it.
- 401 to an anonymous caller, 403 to a signed-in one who is denied. A bearer token passes as its user.
