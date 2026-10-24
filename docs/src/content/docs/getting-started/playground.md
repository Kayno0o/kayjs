---
title: Playground
order: 5
description: Edit a kay component in your browser and see its HTML and its live island, with nothing to install.
---

## Try kay here

Edit the component and the result updates as you type, with a compile error shown at its line. Nothing is sent anywhere: kay's compiler runs in your browser, and loads only on this page.

<Playground />

## What it runs

The playground compiles one `.kay` component the way the build does, once for the server's HTML and once for the browser. The HTML from the server is shown under the editor, and the browser's version runs live in the box beside it. Code that arrives in a link waits for a click on Run, as a link can carry anyone's code; code you type runs as you type. The box is sandboxed: it has no network and cannot reach this site's data.

A component runs here when it imports only from `kay`. That leaves out:

- Pages and anything with a `--- server` fence: data, actions, the request and the session.
- A `--- module` fence, a `markdown` block, and imports from other files, packages or `kay/...` modules such as `kay/i18n` or `kay/image`.

The compiler's check that a component does not read `window` or `document` while rendering is off here, so such a component compiles where `kay check` would refuse it. `await` blocks are not waited for in the HTML. Each `kay` example in these docs that the playground can run has an "Open in playground" link in its header.
