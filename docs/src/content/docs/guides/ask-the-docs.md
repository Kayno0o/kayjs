---
title: Ask the docs
order: 9.6
description: Ask how to do something with kay and get an answer written from these docs, with links to the pages it rests on.
---
The [chat](/ask) answers questions such as "how do I protect an action from bots" or "how do I run a job every night". Type the question in your own words and it answers with the code you need.

## What it reads

The chat starts from `llms.txt`, the short guide to kay written for coding agents. When your question needs more, it searches these docs and reads whole pages: the guides written for people, the full reference written for agents, and the page of each library. It does not read the pages of the kayjs-ui components, but the reference of the library covers them. It reads only what is on this site, so it knows the version of kay the docs describe.

## Answers can be wrong

A language model writes the answers. It can misread a page, mix two of them up or miss a detail. Each answer ends with the pages it rests on: open them to check anything you are about to build on. They open in a new tab, so the conversation stays where it is. When the docs do not cover your question, it says so and points to the closest page.

## What is kept

The site stores no conversation. Yours lives in the page and is gone when you leave it. The limits count your questions in memory by network address and forget them when the server restarts. Each question is sent to the model provider together with the docs it reads, and nothing else about you.

## Only kay

The chat answers questions about kay and its libraries. Before the model is asked, the site checks that your question uses words from these docs. A question about a recipe or the weather gets a short reply saying so, and the model is never called. A short follow-up such as "and with a base path?" goes through.

## Limits

The chat is free to use and paid for by the site, so each visitor may ask a few questions a minute and about a dozen full answers a day (60,000 tokens), and the site as a whole has a daily limit too. A question the chat refuses as off topic counts against none of them. Past a limit it tells you how long to wait. When the chat is off, the page says so, and the search box (press Ctrl K) still works.

## Build one for your own site

This chat is a single kay page with the `Chat` component of [kayjs-ai](/libraries/kayjs-ai). Its source is in kay's repository, in `docs/src/routes/(docs)/ask.kay`.
