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

A page reads the user before it renders when its imports reach `SignedIn`, `SignedOut` or `UserMenu`, through its layouts, components and helpers however deep, so they show in the first bytes, with JavaScript off too. A page not reaching them reads no session, and no option is needed.

- A page reading the session is the visitor's own: no cache shares it between visitors, and a page kept by the build is rendered per request.
- A read that fails there is left to the components, which read again and report it, showing nothing meanwhile.
- `viewer: true` in `auth({ ... })` reads the user on every page, for an app whose own components call `currentUser`; `viewer: false` reads it on none, and the three stream in after the page, a block each, which needs JavaScript.

## Reference

- `viewer` goes beside `module` and `pages` in `auth({ ... })`: left out, the pages reaching the components read the user; `true` reads it on every page, `false` on none.
- `SignedIn` takes `role`; `UserMenu` takes `account`; `SignedOut` takes none. All three import from `@kaynooo/kayjs-auth/components/<name>.kay`.
