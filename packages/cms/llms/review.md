# Review before publishing

A writer who may not publish sends a draft for review; a reviewer approves it, which publishes it, or sends it back with a note. Each step is kept with the entry and the people involved hear of it.

## Common tasks

### Let a team review before publishing

Give the reviewers the `review` action of `cms({ roles })`, and the writers none of `publish`. Nothing else is declared:

```ts
cms({ guard, roles: { writer: [], reviewer: ['review'], publisher: ['publish', 'review'] } })
```

A writer's entry screen and on-page editor offer Submit for review on a draft; a reviewer sees In review and Approve and Send back on it.

### Review with the roles of a kayjs-auth organization

A key of `roles` written `org:<role>` is held by a person holding `<role>` in any organization they belong to, `org:<organization>:<role>` in that one, named by its id or slug:

```ts
cms({ guard, roles: { 'org:writer': [], 'org:reviewer': ['review'], 'org:acme:owner': ['publish', 'review'] } })
```

### Tell reviewers of a submission

A submission is told through `notify()`, with nothing to wire, to the other people who hold a reviewing `org:` role in the organizations of the writer; the Bell of kayjs-ui lists it, linking the entry.

## Reference

- `review` is an action of `cms({ roles })` beside `publish`. Submitting needs none: any person the guard admits sends a draft. Approving and sending back need `review`, checked on the server (a 403 naming the action, `cms.guard.forbidden`) for kayjs-auth roles, `passwordGuard` roles and the roles `cms({ member })` reports alike. Without `roles` everyone admitted may do all of it.
- An `org:` key is checked through kayjs-auth's `auth.isMember(organization, role)`, so the organization's own hierarchy counts (an `owner` holds `reviewer` when the organization's `roles` say so). A site role and an organization role add up. The key is a name in `cms({ member })`'s `roles` like any other; only kayjs-auth's own lookup resolves `org:` keys.
- The routes of the entries API: `POST /entries/<collection>/<slug>/submit`, `/approve` and `/send-back` (`{ note }`, 1 to 1000 characters, required). Each answers `{ saved: true, review }` or `{ issues }`, and `GET /entries/<collection>/<slug>` carries `review`. `submit` refuses an entry that is not a draft or is in review already; `approve` and `send-back` refuse one not in review.
- Approve publishes the entry (the draft flag off, as Publish does), so a publish date ahead still schedules it at that date. A person with `review` and no `publish` publishes through approval alone: Publish stays disabled for them. A reviewer may approve what they submitted.
- A draft sent back keeps its place in the list as Draft with a Sent back badge and the note above its form; a new submission goes on from there. Publishing the entry another way (a publisher's Publish, a save) ends the review, the log noting it; deleting the entry forgets its review, and renaming it moves the review along.
- The list shows In review and Sent back beside Draft in its Status column, the entry screen and the on-page editor show the same badge with the buttons, and the review log (who, when, what, the note) lists the steps on the entry screen and the History screen. The log keeps the last 50 steps.
- Where it is kept: not in the entry's data, so no schema changes and `all()` never sees it. A loaded collection keeps it in a hidden `review` collection of its loader (`sqliteLoader` and `pgLoader` need nothing, a loader of your own gives `sibling('review')` as in [History](history.md#give-a-loader-of-your-own-a-history)), whether or not `cms({ history })` is on. A folder collection keeps it as `.cms/review/<collection>/<slug>.json` at the repository root, written through the `files` saver (`workingTree()` writes it, `forgejo()` commits it as `content(<collection>): submit <slug>`), and read from disk as its entries are, so a deployed site shows it with the next deploy.
- A collection needs a draft flag (`draft` in `collection()`) and, when loaded, a loader with `sibling`; otherwise the buttons are not drawn and the routes answer `cms.review.unavailable`.
- Notifications use `notify(userId, { title, url })`: reviewers hear `cms.review.submitted`, the writer `cms.review.approved` or `cms.review.sentBack` with the note. Only a kayjs-auth user has an inbox, and kayjs-auth lists no one by site role without an admin, so the people told of a submission are the members of the writer's organizations holding the reviewing `org:` role itself (not a role above it in the hierarchy); a `passwordGuard` or `member()` writer gets no notification, and a reviewer by site role finds the draft in the list. A failing notification is logged and never fails the step.
- The activity log and `onSave` keep their verbs: an approval is a `publish` there, a submission and a send-back are not saves. A loaded entry's History screen lists the review log above its versions.
