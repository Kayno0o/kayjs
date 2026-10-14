---
title: content/
order: 14
description: The Markdown, JSON and YAML files content collections read.
path: src/content/
---

`src/content/` holds the files of the content collections, one folder per collection. [`src/content.config.ts`](/structure/content-config) declares each, its folder relative to that file, so `content/posts` is `src/content/posts`.

<FileTree tree="
src/content/
  posts/
    hello.md
    second-post.md
  authors/
    ada.yaml
" />

Each file is checked against its collection's schema: an entry that does not match fails `kay check` at the field's line, and fails the build. A Markdown entry can use the components its collection lists, written with a capital as in a template.

<ReadMore href="/guides/content">Content collections, a page per entry, feeds and CMS sources.</ReadMore>
