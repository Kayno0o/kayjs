# kayjs-auth: The signed-in user in templates

## Common tasks

### Show or hide a part for the signed-in user

`SignedIn`, `SignedOut` and `UserMenu` read the request's user themselves, so a layout or a component shows the user with no `--- server` fence. They are sugar over `ctx.user`, `ctx.can(role)` and `ctx.impersonator`, which any template reads the same way, `if ctx.user as user` or `if ctx.can('admin')` ([Request values](../../../llms/request-values.md)):

```kay
---
import SignedIn from '@kaynooo/kayjs-auth/components/signed-in.kay'
import SignedOut from '@kaynooo/kayjs-auth/components/signed-out.kay'
import UserMenu from '@kaynooo/kayjs-auth/components/user-menu.kay'
---
nav
  SignedOut
    a(href="/auth/sign-in") Sign in
  SignedIn(role="admin")
    a(href="/admin") Admin
  UserMenu
```

- `SignedIn` renders its children for a signed-in user, and with `role="admin"` for one holding that role, the app's `roles` hierarchy applied. `SignedOut` renders them for a visitor.
- `UserMenu` shows the user's username or email, a link to their account when the prebuilt pages are on (`account={false}` leaves it out) and a sign-out button back to the pages' home. The account pages' own header is one.
- A guest is signed out for all three.
- `role` only hides markup, the page and its data are still served: guard the route with `auth.guard` for access.
- They read the request being answered, so a page with `prerender: true` fails the build asking you to render it per request. They nest in one another and in the app's own `await` blocks.

### Show the impersonation banner

`ImpersonationBanner` shows an admin acting as a user, with a button back to their own account, and nothing for anyone else. The prebuilt pages carry it already; put it in a layout of your own with no fence and no option:

```kay
---
import ImpersonationBanner from '@kaynooo/kayjs-auth/components/impersonation-banner.kay'
---
ImpersonationBanner
slot
```

- It reads `ctx.impersonator`, the admin behind the session (null for none), so a page reaching it shows the banner in the first bytes, once per request even in a layout and a page both holding one.
- The button posts to `<prefix>/stop-impersonating` under the base and back to the admin pages (the pages' home when the admin pages are off), worded in the page's locale.

### Show them with the first bytes

A page reads the user before it renders when its imports reach `SignedIn`, `SignedOut`, `UserMenu` or any template reading `ctx`, through its layouts, components and helpers however deep, so they show in the first bytes, with JavaScript off too. A page not reaching them reads no session, and no option is needed.

- A page reading the session is the visitor's own: no cache shares it between visitors, and a page kept by the build is rendered per request.
- A read that fails there is left to the components, which read again and report it, showing nothing meanwhile.
- `viewer: true` in `auth({ ... })` reads the user on every page, for an app whose own components call `currentUser`; `viewer: false` and the default read it only where a template reads `ctx`.

## Reference

- `viewer` goes beside `module` and `pages` in `auth({ ... })`: left out, the pages reaching a template reading `ctx` read the user; `true` reads it on every page.
- `SignedIn` takes `role`; `UserMenu` takes `account`; `SignedOut` and `ImpersonationBanner` take none. All four import from `@kaynooo/kayjs-auth/components/<name>.kay`.
