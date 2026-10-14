---
title: How a request runs
order: 9
description: What runs on the server and what in the browser, from a page's request to an action's post and the next page.
---

A page is code on the server first, HTML in the browser next, and JavaScript only where a component reacts to the user. Each step below links the page that details it.

<RequestFlow />

## On the server

A request for `/posts/12` matches `src/routes/posts/[id].kay`, and every `_layout.kay` in the folders above it wraps it, the outermost first. Before anything renders, each `_guard.ts` on the way runs, and can deny the request or redirect it.

The page's `--- server` fence and those of its layouts then run side by side, for this request only: what they declare is what their templates read, and none of their code reaches the browser. A page with `prerender` runs them once, at `kay build`, and is served as a file after that.

The templates render to HTML, each component's `---` script running as its template renders. An `await` block lets the page go out before its value arrives, which streams in after; a [server island](/essentials/routing#server-islands) renders for each request inside a page otherwise prerendered.

## In the browser

The browser shows the HTML as it arrives. A page whose components never react to the user ships no JavaScript bundle at all.

An [island](/essentials/islands) is a component with an event handler, a `bind:` or a signal. kay rendered it on the server like the rest; in the browser its `---` script runs again with the props the page sent it, and attaches its handlers, on load by default, or once the browser is idle or the island nears the screen.

## Through an action

A form posting to an [action](/essentials/forms-and-actions) works without JavaScript. The server checks the input against the action's schema, runs the guards, then the handler. A refusal renders the page again with the errors and the values typed; a success goes back to the page, or wherever `ctx.redirect` sends it. An island can call the same action as a function, and the page's loads run again after it.

## The next page

On a page with an island or a form, kay's script takes over the links: the [next page](/essentials/islands#page-navigation) is fetched and swapped in without a reload. What renders the same stays in place, the islands of the old page end and those of the new one hydrate, and an island marked `persist`, such as a player, keeps playing through it.
