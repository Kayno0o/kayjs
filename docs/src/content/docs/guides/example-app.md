---
title: "Example: kay with its libraries"
order: 2
description: A tour of the noticeboard example, which runs kay with kayjs-auth, kayjs-mail, kayjs-ui and Postgres together.
---

The tutorial builds an app from kay alone. [examples/noticeboard](https://github.com/Kayno0o/kayjs/tree/main/examples/noticeboard) in kay's repository is the next step: a club noticeboard running kay with the libraries a real site takes, each wired as its own reference says.

- **Members** join and sign in through `@kaynooo/kayjs-auth`, with a password or a mailed link, and confirm their address from a mail. Its tables live in Postgres beside the app's, through `@kaynooo/pg-orm` and `pgStore`, and `/account` sits behind `auth.guard()`.
- **Mail** goes through `@kaynooo/kayjs-mail`: kayjs-auth's links are queued on it, and a notice's announcement is a `.kay` component built from its `Layout`, `Heading` and `Button`.
- **A queue** of kay's, `announcements`, mails each new notice to the members with a confirmed address, after the post has answered.
- **Rooms** of kay's carry the board's websocket: who is reading, and each notice as it is pinned, which shows on every open board through `refresh()` with a toast.
- **Components** of `@kaynooo/kayjs-ui` draw the cards, the badges, the form fields, the dialog pinning a notice through the page's action, and the toasts.

Its tests sign in through the site's own forms, read the mails from the outbox, run the queues with `site.runJobs()`, listen on the websocket with `site.socket()` and pin a notice in a browser, each test file on a copy of the migrated database. Its `README.md` says how to run it, test it and build its container.
