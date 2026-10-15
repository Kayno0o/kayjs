---
title: What's new
order: 10.5
description: What each release of kay and its libraries adds, with a link to where each feature is documented.
---
This page lists what each release adds, newest first, with a link to where each feature is documented. kay and its libraries share one version number, so one section covers them all. What a release breaks, and what to change in your app, is in [Upgrading](/guides/upgrading).

## Unreleased

- **`images.card.logo`** puts the site's logo at the top left of every share card, an SVG or an image. [Social card](/essentials/head-and-seo#social-card)
- **A kingfisher is kay's default favicon**, shown by a site that names none of its own. [Favicon](/essentials/head-and-seo#favicon)
- **`kay render <url>`** prints the HTML a page renders without starting a server, so a script or a coding agent can check a page in one command. [kay render](/reference/cli#kay-render)
- **`--format json`** on `kay build`, `kay routes`, `kay explain`, `kay fmt` and `kay migrate` prints one JSON document, as `kay check` already did. `kay routes --format json` gives a tool every route with its layouts and guards. [Output for tools](/reference/cli#output-for-tools)
- **`kay build` shows its progress** in a terminal: one line redrawn in place, with the step, its time and a bar over the routes it prerenders and the images it encodes. Piped or in CI, it prints the same lines as before. [kay build](/reference/cli#kay-build)
- **`--quiet`** on `kay build`, `kay check`, `kay fmt`, `kay migrate` and `kay new` prints only the problems and one summary line. [Quiet and plain output](/reference/cli#quiet-and-plain-output)
- **`kay dev` lists its errors in `.kay/dev/errors.json`**, so a coding agent running it in the background reads what broke without a browser, and `kay dev --format json` prints each event as JSON. [Errors without a browser](/reference/cli#errors-without-a-browser)
- **`kay dev` reads keys in a terminal**: `o` opens the browser, `r` restarts, `c` clears the screen, `q` quits. Under `--host` it also prints the address other devices reach it at. [kay dev](/reference/cli#kay-dev)
- **`watch` and `debounced`** from `kay`: `watch` runs on a change only, handed the value before, and `debounced` gives a value once it stops changing. [Islands](/essentials/islands#browser-only-code)
- **Assigning a signal writes it** wherever it was made, `cart = []` on a signal held in a `const`, an import or a prop, and `kay check` reports an assignment to a name holding no signal. [Signals, memos and effects](/essentials/islands#signals-memos-and-effects)
- **Proof of work in a form field**: `workChallenge` and `verifyWork` from `kay/server` make a post cost the sender CPU, with no third-party script. kayjs-auth now uses it as its default CAPTCHA, which [Upgrading](/guides/upgrading#1440) covers. [Forms and actions](/essentials/forms-and-actions)
