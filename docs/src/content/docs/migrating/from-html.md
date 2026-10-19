---
title: Migrating from HTML
order: 5
description: Turn HTML from Tailwind UI, a designer or an LLM into a kay template, in the browser or with kay fmt --from-html.
---

## Paste HTML here

Paste a snippet, a component from a UI kit or a whole page. The template appears beside it, ready to copy into a `.kay` file. Nothing is sent anywhere: the conversion runs in your browser, and loads only once you click into the box.

<HtmlConverter />

## On the command line

`kay fmt --from-html` does the same for a file or for what it reads on stdin.

```sh
kay fmt --from-html hero.html > src/components/hero.kay
curl -s https://example.com/card.html | kay fmt --from-html
```

It shares its translation with [`kay migrate astro`](/migrating/from-astro), so both write markup the same way.

## What it writes

- Tag names, `.class` and `#id` as kay's shorthand, so `<div class="flex gap-2" id="top">` becomes `#top.flex.gap-2`.
- Classes, Tailwind's `py-0.5`, `md:w-[200px]` and `bg-(--brand)` included. A class the shorthand cannot hold, such as one with an unclosed `[`, stays in a `class="..."` attribute.
- Attributes in parentheses, text on the element's line, and inline elements such as `<strong>` and `<a>` inside the text as `#[strong text]`.
- The space a browser shows between two inline elements on separate lines, such as two links, kept as a space.
- `<script>` and `<style>` with their content kept as it was.
- An HTML comment as a `//` comment. Those are template comments, so they are not in the rendered page.
- The children of a document's `<head>` in a `head` block, and the children of `<body>` as the template.

The output is already formatted, so `kay fmt` leaves it alone, and it renders the same HTML back.

## What you finish by hand

The conversion lists what it left out, one line each. Look at these.

- An attribute that kay cannot name, such as Alpine's `@click` or Vue's `:class`. Write it as an event or a binding in an island.
- `lang` on `<html>`, which belongs in `kay.config.ts`, and the attributes of `<body>`, which kay writes itself.
- A tag HTML lets you leave open, such as `<li>` or `<p>` without its end tag. Close it first, as the conversion fails on it.
- A web component's `<slot>`, which kay cannot write as an element, as a comment with a note.
- Whitespace inside `<pre>` and `<textarea>`, which the template collapses; the conversion notes each one.
- Anything dynamic. The result is static markup: turn repeated items into a `for`, and values into props.
