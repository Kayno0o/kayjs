# kayjs-auth: The prebuilt organization pages

## Common tasks

### Let users run their organizations from the browser

With the `organizations` option and the prebuilt pages, the account area gets an `Organizations` tab under the pages' prefix, `/auth/account/organizations` by default, with no other declaration. Invitation mails link to the pages' own `/auth/invitation` when `invitationPage` is not set:

```ts
createAuth({
  // ...
  organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin', defaultRoles: ['member'] },
})
```

- `/auth/account/organizations`: the user's organizations, the invitations open to their verified address (`Join` or `Decline`), and a form creating one (a name, an optional address).
- `/auth/account/organizations/<org>`, `<org>` the slug or the id: the members with their roles, and for a manager (the `manage` role) the roles of each member below them, their removal, the open invitations with a form inviting an address (given roles, else `defaultRoles`) and a `Revoke` button, and the name and address of the organization. Every member can leave it behind a ticked box, and an owner can delete it behind a ticked box.
- `/auth/invitation?invitation=<id>`: the page an invitation mail opens, for anyone holding the link. A visitor sees the organization and the invited address with `Sign in` and `Create an account`, both coming back to the link. The invited, signed-in account sees `Join` and `Decline`. Another account is told the invitation is for another address and may sign out to sign in with the right one. A revoked, spent, expired or unknown id says the invitation is invalid.
- A visitor is sent to sign in as for the account pages, a stranger to an organization gets a 404 so its existence does not leak, and the pages answer 404 on a site with no `organizations`. The actions answer as the methods do, so a post that skips the page changes nothing: a member without the role gets `forbidden`, a manager cannot touch an owner, and the last owner cannot leave, be removed or lose the role (`last-owner`).
- The pages follow the prefix, the base path and the locale of the other prebuilt pages (`/fr/auth/account/organizations`), and `pages: false` leaves them out with the rest.
- The words are `auth.organizations.*` and `auth.invitation.*` in the app's catalogs; English and French ship. An invitation is mailed only with a mailer set up, and the invite form shows only then.

## Reference

- `features().organizations` is `{ roles, owner, manage }`, or null without the `organizations` option.
- `invitationPage` still names a page of your own, which then replaces `/auth/invitation` in the mail.
- Accepting needs an account whose verified address is the invited one: an invitee without an account registers with that address, verifies it, and comes back to the link.
