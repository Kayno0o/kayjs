# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- `collection(..., { title })` names a collection on the kayjs-cms screens ([Content](content.md)).
- kayjs-ai `Chat`: a wide table scrolls inside its bubble, a message refused with 422 returns to the field on a retry too, the history posted never opens on an assistant message, and an action that can `ctx.fail` is accepted as `action` ([kayjs-ai](../packages/ai/llms/chat.md)).
- A stream an action answers with to an event handler closes with its island, so a `persist` island's stays open across pages ([actions from islands](api-from-islands.md)).

Releases before 1.53 are in [What's new, older releases](whats-new-archive.md).
