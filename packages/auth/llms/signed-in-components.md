# kayjs-auth: The signed-in user in templates

## Common tasks

### Show or hide a part for the signed-in user

`SignedIn` and `UserMenu` read the request's user themselves, so a layout or a component shows the user with no `--- server` fence. They are sugar over `ctx.user`, `ctx.can(requirement)` and `ctx.impersonator`, which any template reads the same way, `if ctx.user then user` or `if ctx.can('admin')` ([Request values](../../../llms/request-values.md)):

```kay
---
import SignedIn from '@kayjs/auth/components/signed-in.kay'
import SignInLink from '@kayjs/auth/components/sign-in-link.kay'
import SignOutButton from '@kayjs/auth/components/sign-out-button.kay'
import UserMenu from '@kayjs/auth/components/user-menu.kay'
---
nav
  SignedIn
    a(href="/account") Account
    @else
      SignInLink
  SignedIn(require="admin")
    a(href="/admin") Admin
  UserMenu
  SignInLink(button tone="accent" label="Join")
  SignOutButton(redirect="/goodbye" variant="ghost")
```

- `SignedIn` renders its children for a signed-in user, and with `require` for one meeting it, what `auth.guard({ require })` takes: a role under the app's `roles` hierarchy, `{ type, resourceId }`, a list of which any one passes, or a predicate `user => user.email.endsWith('@acme.com')`. A predicate gets the user and an empty context (no `params` or `request`) and answers a boolean at once, as a template renders without waiting, so a check that reads a store or the route is done in the page's server fence; a `{ type, resourceId }` naming a record never passes. `ctx.can(requirement)` takes the same.
- Its `@else` block renders for anyone who does not meet that: a visitor, a guest, or a signed-in user lacking `require`. It is the place for a sign-in link, and replaces `SignedOut`.
- `SignedIn(role=)` and `SignedOut` still work until 1.108: `deprecated-auth-signed` renames `role` to `require` and reports `SignedOut`, whose children go into an `@else` block of the `SignedIn` beside it.
- `UserMenu` shows the user's username or email, a link to their account when the prebuilt pages are on (`account={false}` leaves it out), its children, and a sign-out button back to the pages' home (`redirect` names another path). A visitor gets a link to the sign-in page instead, `signIn={false}` leaving it out. The account pages' own header is one.
- `SignOutButton` is the form posting to the sign-out route, a Button inside it: `redirect` is the path to go to after, put in the page's locale (the pages' `home` by default), `label` words the button and children follow it, and `variant`, `tone`, `size`, `icon` and attributes are the Button's. `class` styles the form, `parts={{ button: '...' }}` the button. It never reads the prefix: the app writes no `features().prefix`.
- `SignInLink` is a link to the sign-in page leading back to the page it is on: `redirect` names another path of the site, `href` another page altogether (the app's own sign-in), `label` the wording, children following it. `button` draws it as a Button, taking `variant`, `tone`, `size` and `icon`.
- A guest is signed out for all of them.
- `require` only hides markup, the page and its data are still served: guard the route with `auth.guard` for access.
- They read the request being answered, so a page with `prerender: true` fails the build asking you to render it per request. They nest in one another and in the app's own `await` blocks.

### Show the impersonation banner

`ImpersonationBanner` shows an admin acting as a user, with a button back to their own account, and nothing for anyone else. The prebuilt pages carry it already; put it in a layout of your own with no fence and no option:

```kay
---
import ImpersonationBanner from '@kayjs/auth/components/impersonation-banner.kay'
---
ImpersonationBanner
slot
```

- It reads `ctx.impersonator`, the admin behind the session (null for none), so a page reaching it shows the banner in the first bytes, once per request even in a layout and a page both holding one.
- The button posts to `<prefix>/stop-impersonating` under the base and back to the admin pages (the pages' home when the admin pages are off), worded in the page's locale.

### Show a pending deletion

With `account.deleteAfter`, `DeletionBanner` (`@kayjs/auth/components/deletion-banner.kay`, no props or fence) shows `Your account will be deleted on <date>` and a button that cancels (a post to `<prefix>/cancel-deletion`), and nothing for anyone else. The prebuilt pages carry it, as do all pages with `viewer: true`; put it in a layout of your own elsewhere, once per request. It reads `ctx.deletion`, the date or null. See [Deleting an account after a grace period](passwords-and-mails.md#deleting-an-account-after-a-grace-period).

### Show them with the first bytes

A page reads the user before it renders when its imports reach `SignedIn`, `UserMenu`, `SignInLink`, `SignOutButton` or any template reading `ctx`, through its layouts, components and helpers however deep, so they show in the first bytes, with JavaScript off too. A page not reaching them reads no session, and no option is needed.

- A page reading the session is the visitor's own: no cache shares it between visitors, and a page kept by the build is rendered per request.
- A read that fails there is left to the components, which read again and report it, showing nothing meanwhile.
- `viewer: true` in `auth({ ... })` reads the user on every page, for an app whose own components call `currentUser`; `viewer: false` and the default read it only where a template reads `ctx`.

## Reference

- `viewer` goes beside `module` and `pages` in `auth({ ... })`: left out, the pages reaching a template reading `ctx` read the user; `true` reads it on every page.
- `SignedIn` takes `require` and an `@else` block; `UserMenu` takes `account`, `signIn` and `redirect`; `SignOutButton` takes `redirect`, `label` and a Button's props; `SignInLink` takes `redirect`, `href`, `button`, `label` and a Button's props (`variant`, `tone`, `size`, `icon`, `busy` and `spinner` apply only with `button`); `ImpersonationBanner` and `DeletionBanner` take none. `SignedOut` takes none and is deprecated. All import from `@kayjs/auth/components/<name>.kay`.
