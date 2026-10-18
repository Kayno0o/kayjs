---
title: Ask the docs
order: 9.6
description: Ask how to do something with kay and get an answer written from these docs, with links to the pages it rests on.
---
The chat button at the bottom right of every page opens a chat that answers questions such as "how do I protect an action from bots" or "how do I run a job every night". Type the question in your own words and it answers with the code you need.

## What it reads

The chat starts from `llms.txt`, the short guide to kay written for coding agents. When your question needs more, it searches these docs and reads whole pages: the guides written for people, the full reference written for agents, and the page of each library. It does not read the pages of the kayjs-ui components, but the reference of the library covers them. It reads only what is on this site, so it knows the version of kay the docs describe.

## Answers can be wrong

A language model writes the answers. It can misread a page, mix two of them up or miss a detail. Each answer ends with the pages it rests on: open them to check anything you are about to build on. A link opens the page in place and the chat stays open beside it, so you can keep reading and asking. When the docs do not cover your question, it says so and points to the closest page.

## What is kept

The site stores no conversation. Yours lives in the page and in your browser tab's session storage, so a reload keeps it, and it is gone when you close the tab. The limits count your questions by network address and keep the counts in a file on the server, so a restart does not reset them. Each question is sent to the model provider together with the docs it reads, and nothing else about you.

## Only kay

The chat answers questions about kay and its libraries, and declines anything else, such as a recipe or the weather.

## Limits

The chat is free to use and paid for by the site, so each visitor may ask a few questions a minute and about a dozen full answers a day (60,000 tokens), and the site as a whole has a daily limit too. Past a limit it tells you how long to wait. When the chat is off, it says so, and the search box (press Ctrl K) still works.

## Build one for your own site

This chat is the `ChatLauncher` component of [kayjs-ai](/libraries/kayjs-ai), placed once in the docs layout. Its source is in kay's repository: the layout in `docs/src/routes/(docs)/_layout.kay` and the actions it calls in `docs/src/routes/(docs)/_actions.kay`.
