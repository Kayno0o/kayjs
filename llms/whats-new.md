# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## 1.55.1
## Unreleased

- kayjs-auth no longer counts a passkey made without user verification as a way in: `passkeys()` lists `userVerified`, see [Upgrading](upgrading.md).

## 1.55.0

- The `deprecated-api-tool` lint, which only warned while `kay upgrade` moved an app from before 1.51, is gone ([Checks](checks.md)).
- An `_error.kay` drawn for a hook that threw reads the locals your `derive` added before it threw.
- A sitemap built with a `lastmod` left out is kept for a minute, not an hour.
- The analytics notice is fetched again after a failed load and carries the tracker's CSP nonce.
- kayjs-ui `Sortable` names a bare handle after its item (`Reorder Milk`) and leaves an image with `alt` to name it, `mountComponent` mounts a component that `call()`s a library's API, and a numbered CMS list says the place a moved item left ([Drag and drop](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-ai `Chat` takes `maxChars` (40,000), to match a lower `maxInputChars` ([Chat](../packages/ai/llms/chat.md)).
- Fathom and Cloudflare keep `'self'` in the policy's `script-src` and `connect-src`; it was replaced, which blocked the site's own scripts ([Privacy](privacy.md)).

Releases before 1.55.1 are in [What's new, older releases](whats-new-archive.md).
