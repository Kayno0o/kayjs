---
title: public/
order: 20
description: Files served at their path as they are.
path: public/
---

A file in `public/` is served at its path as it is, so `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL.

An image or a font a component uses is imported instead, which names its URL after its content.

<FileTree tree="
public/
  robots.txt  /robots.txt
  logo.png  /logo.png
  shelf/
    books.html  /shelf/books
    index.html  /shelf
" />

An HTML file is also served without its `.html`, as a static host does, and an `index.html` at its folder's path. `kay check` accepts links to these paths.

A file sharing its path with a page, an endpoint, a redirect or an API route stops the server at boot.

Set `publicDir` in [`kay.config.ts`](/structure/kay-config) to use another folder.

<ReadMore href="/essentials/styling-and-assets#public-files">Public files and imported assets in the styling guide.</ReadMore>
