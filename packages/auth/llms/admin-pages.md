# kayjs-auth: The prebuilt admin pages

## Common tasks

### Manage users from the browser

With `admin: 'admin'` set (or any requirement a guard takes), the prebuilt pages serve an admin area under the pages' prefix, `/auth/admin` by default, with no other declaration:

```ts
// kay.config.ts
extensions: [auth({ admin: 'admin', roles: { admin: ['editor'], editor: [] }, audit: true })]
```

- `/auth/admin`: the users, newest first, 25 a page, with a search over part of an email or a username or a whole id (`?q=`, `?page=`).
- `/auth/admin/users/<id>`: one user, with their roles (give one of the declared `roles`, take one back), a ban with a reason and an optional last day, the lift of a ban, `Act as this user`, and the deletion behind a ticked box. With `audit` on, their last 20 audit entries show too.
- `/auth/admin/audit`: everyone's audit log, 50 entries a page, an `Older entries` link paging by the last entry.
- Each page is as open as the method behind it: a visitor is sent to sign in, anyone else (a member, an admin already acting as a user, a bearer token) gets a 403, and a site naming no `admin` gets a 404. The actions answer the same through the methods, so a post that skips the page changes nothing.
- A change asks for a sign-in under ten minutes old, as the methods do: the page says so with a `Sign in again` button that comes back to the user.
- The pages follow the prefix, the base path and the locale of the other prebuilt pages (`/fr/auth/admin`), and `pages: false` leaves them out with the rest.

### Show who an admin acts as

`impersonate` signs the admin in as the user, and a banner says so on every prebuilt page and, with `viewer: true`, on every page of the app: `You are acting as ada@example.com.` with a `Back to my account` button that posts to `<prefix>/stop-impersonating` (`redirect` for where to go, a path of the site) and lands on the admin pages. Put `ImpersonationBanner` from `@kaynooo/kayjs-auth/components/impersonation-banner.kay` in a layout of your own where `viewer: true` does not reach.

## Reference

- `auth.requireAdmin()` is the guard of the pages for your own admin page: the signed-in admin as themselves, else the refusal above.
- `features().admin` is `{ roles }` while an admin is named, else null.
- The words are `auth.admin.*` and `auth.impersonation.*` in the app's catalogs; English and French ship.
- Organization pages (members, roles, invitations) are not prebuilt yet: the methods in [admin and organizations](admin-and-organizations.md) have no screen.
