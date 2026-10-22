# kayjs-auth: The signed-in user in templates

## Common tasks

### Show or hide a part for the signed-in user

`SignedIn`, `SignedOut` and `UserMenu` read the request's user themselves, so a layout or a component shows the user with no `--- server` fence, so a layout can hand an island its slots:

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
- They read the request being answered, so a page with `prerender: true` fails the build naming them: render it per request. They nest in one another and in the app's own `await` blocks.

### Show them with the first bytes

`auth({ module: './src/auth', viewer: true })` in `kay.config.ts` reads the user before every page renders, so the three show in the first bytes, with JavaScript off too. Without it they stream in after the page, a block each, which needs JavaScript, and a page not showing the user costs no read.

- `viewer: true` reads the session on every page, so none is shared by a cache between visitors and a page kept by the build is rendered per request.
- A read that fails there is left to the components, which read again and report it, showing nothing meanwhile.

## Reference

- `viewer: true` goes beside `module` and `pages` in `auth({ ... })`; it is `false` by default.
- `SignedIn` takes `role`; `UserMenu` takes `account`; `SignedOut` takes none. All three import from `@kaynooo/kayjs-auth/components/<name>.kay`.
