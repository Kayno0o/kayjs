# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## 1.52.3

- Claude Code lists an app's MCP tools: a list or a read in the 2026-07-28 revision says how long a client keeps it, `ttlMs` and `cacheScope`, as that revision requires ([API routes](api-routes.md#mcp)).

## 1.52.2

- `onError` gets the errors of `schedule`, `background` and queue jobs and `onStop` hooks, with no request, and an island's stack is mapped to `.kay` lines in production ([Error reporting](routing.md#error-reporting), [Error fallbacks](islands.md#error-fallbacks)).
- kayjs-cms: `cms({ collections })` arranges a form (field order, rows of columns, hidden fields) and a list (columns, row actions), and the screens' parts, `createEntryForm`, `entryScreen` and `listScreen` are exported to build an entry screen of your own ([screens](../packages/cms/llms/screens.md)).
- A page of many rules, Markdown pages included, links a copy of the stylesheet cut to the classes it names instead of every component's rules, loaded before a page swap paints ([styles](styles-and-assets.md#link-or-inline-the-stylesheets)).
- kayjs-ai's `Chat` announces each tool call's start and end to screen readers through its polite status line, and a Stop before the first word returns the message to the field ([Chat island](../packages/ai/llms/chat.md)).
- kayjs-ai's `Chat` names each table of a reply as a `group`, numbered when a reply has several, and escapes `tableLabel` ([Chat island](../packages/ai/llms/chat.md)).
- A page with a `--- server` fence passes an island an action, `Chat(action={reply})` with no wrapper ([actions](actions.md#pass-an-action-to-an-island)).
- `island-action` reports an action handed to an island that never types a prop as one ([actions](actions.md#pass-an-action-to-an-island)).
- `secret-prop` warns of a secret-looking field, as `user.passwordHash`, handed to an island ([islands](islands.md#props-to-an-island)).
- `kay screenshot` and an MCP `screenshot` tool shoot a page of `kay dev`, with a diff, and `--cookie` shoots one behind a session ([tools](check-and-tools.md#screenshot-a-page)).
- `kay not-found` lists the paths production found nothing at, with a target, and writes the redirect ([Redirects](routing.md#redirects)).
- The dev tool's Not found tab lists the paths production found nothing at, and turns one into a redirect with a click ([dev server](dev-server.md)).
- `deprecated-api-tool` is reported by `kay upgrade` of an app from before 1.51 alone: an app turning `mcp` on since gets no warning for routes that do not opt in ([Checks](checks.md)).
- A stream an action answers with to a leaving row's handler or a `listen` callback closes with its island too ([actions from islands](api-from-islands.md)).
- A streamed `await` part's island cleans up still in the page ([Streaming](rendering.md#streaming)).

## 1.52.1

- `collection(..., { order: 'position' })` orders a collection by a number field, and kayjs-cms moves its entries up or down by writing it ([Content](content.md)).
- `collection(..., { title })` names a collection on the kayjs-cms screens ([Content](content.md)).
- kayjs-cms: every image preview has the same square box, and a list item carries no required asterisk. kayjs-ui: a grouped `FormField`'s legend keeps its layout under an app's own `legend` styles ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: an image or file field keeps its path behind a collapsed Path control, the preview and the upload button alone showing ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: the items of a list field move up and down, with buttons or Alt and an arrow key ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: `s.Integer()`, `s.Numeric()`, `s.BooleanString()` and `s.Date()` fields get a number, toggle or date input, not a JSON box ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-cms: a literal's `title` labels its option in a select, the value staying what is stored ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-ai `Chat`: a wide table scrolls inside its bubble, a message refused with 422 returns to the field on a retry too, the history posted never opens on an assistant message, and an action that can `ctx.fail` is accepted as `action` ([kayjs-ai](../packages/ai/llms/chat.md)).
- A stream an action answers with to an event handler closes with its island, so a `persist` island's stays open across pages ([actions from islands](api-from-islands.md)).

Releases before 1.52.1 are in [What's new, older releases](whats-new-archive.md).
