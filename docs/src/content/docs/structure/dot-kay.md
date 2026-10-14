---
title: .kay/
order: 21
description: What kay generates, types and builds included, never edited nor committed.
path: .kay/
---

kay writes `.kay/` at the project's root, and nothing in it is the project's to edit. List it in `.gitignore`.

<FileTree tree="
.kay/
  types/  the types of every .kay file, which tsconfig.json reads
  client/  the browser build kay build writes
  dev/  the browser build kay dev writes
  cache/  compiled files, so a restart compiles only what changed
  classes.txt  the .class shorthand's classes, handed to Tailwind
" />

A `.ts` file imports a component as `import Card from './card.kay'`, typed through the `.kay/types` tree that [`tsconfig.json`](/structure/tsconfig) merges with the sources. `kay dev` builds into `.kay/dev` rather than `.kay/client`, so a `kay build` or a test run beside it leaves the files its pages link in place.

<ReadMore href="/llms/project">The project, its commands and their builds in the full reference.</ReadMore>
