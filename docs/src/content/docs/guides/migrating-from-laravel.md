---
title: Migrating from Laravel
order: 10.3
description: Find where the parts of a Laravel app live in kay, and see what kay leaves to you.
---

Moving from Laravel to kay changes the language and the framework at once, so this page stays short. It maps the parts of a Laravel app you will look for first. There is no `kay migrate` command for it, and the code does not translate: you rewrite each route in TypeScript.

kay renders on the server like Laravel does. Where Laravel sends a Blade view and leaves the JavaScript to you, kay sends HTML and hydrates only the components that react to the user. Start with `kay new` (see [Installation](/getting-started/installation)).

## Routes, controllers and views

Laravel splits a page in three: a line in `routes/web.php`, a controller method and a Blade view. In kay one file is all three. Its path is the URL, its `--- server` fence is the controller, and its template is the view.

```php
// routes/web.php
Route::get('/posts/{slug}', [PostController::class, 'show']);

// PostController
public function show(string $slug)
{
    $post = Post::where('slug', $slug)->firstOrFail();

    return view('posts.show', ['post' => $post]);
}
```

```blade
<h1>{{ $post->title }}</h1>
```

In kay, `src/routes/posts/[slug].kay`:

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

| Laravel | kay |
| --- | --- |
| `Route::get('/about', ...)` | `src/routes/about.kay` |
| `{slug}` in a route | `[slug]` in the file name, read as `ctx.params.slug` |
| `{page?}` | `[[page]]` |
| `where('id', '[0-9]+')` | `[id=integer]`, or a matcher in `src/params/` |
| `Route::post(...)` for a form | An `action` exported from the page, see [Forms and actions](/essentials/forms-and-actions) |
| `Route::get('/api/...')` returning JSON | An [API route](/guides/api-routes) in `src/api/` |
| `redirect('/login')` | `ctx.redirect('/login')` |
| `abort(404)` | `ctx.notFound()` |
| `abort(403)` | `ctx.deny(403, 'Members only')` |
| `request()->query('q')` | `ctx.query`, typed by a `query` schema in `page` |
| `Route::redirect(...)` | `redirects` in `kay.config.ts` |

A route does not bind a model for you, as `{post}` does in Laravel. Write `?? ctx.notFound()` after the lookup.

## Blade

| Blade | kay |
| --- | --- |
| `{{ $name }}` | `{name}`, escaped |
| `{!! $html !!}` | `innerHTML` through `trustHtml` or `sanitizeHtml`, see [Templates](/essentials/templates#markup-in-a-spread) |
| `@if`, `@else` | `if`, `else` |
| `@foreach`, `@forelse` | `for`, and `else` for an empty list |
| `@extends` and `@yield` | A `_layout.kay`, which renders the page at `slot` |
| `@section` | An `@name` block, rendered with `slot name` |
| `<x-card :title="$t">` | `Card(title={t})`, a `.kay` component with typed `props` |
| `@include` | A component, imported in the script |
| `@csrf` | Nothing to add: an action refuses a post from another site |
| `old('title')` | Nothing to add: a refused post renders the page again with what was sent |
| `@error('title')` | `error title` in a form |
| `__('messages.welcome')` | `t('welcome')` from `kay/i18n`, see [Internationalization](/guides/i18n) |

A Blade view is HTML with PHP. A kay template is indented, like Pug, and `kay check` types it. See [Templates](/essentials/templates) and [Components](/essentials/components).

## Validation

A form request class becomes the schema of an action. kay checks the input against it before the handler runs.

```kay
--- server
import { s } from 'kay'
import { createPost } from '../posts'

const newPost = s.Object({
  title: s.String({ minLength: 1, maxLength: 200, error: 'Write a title' }),
})

export const create = action(newPost, async ({ title }) => {
  await createPost(title)
})
---
form(action={create})
  input(field="title")
  error title
  button Save
```

`field="title"` names the input, and `kay check` verifies it against the schema. The browser checks `required` and `maxlength` too, and the form works without JavaScript.

## Middleware, auth and sessions

| Laravel | kay |
| --- | --- |
| Middleware that redirects or aborts | A `_guard.ts`, which runs before every page, action and endpoint in its folder and below |
| Middleware that adds data to the request | An Elysia plugin using `derive`, which puts it on `ctx.locals` |
| `Auth::user()` | `ctx.locals.user`, once the app derives it |
| The session | `session()` from `kay/server` |
| Breeze or Fortify | [kayjs-auth](/libraries/kayjs-auth), which ships the sign-in and account pages |
| Gates and policies | None: write the check in a guard or in the handler |

See [Sessions and guards](/guides/sessions-and-guards).

## Queues, scheduler, mail and files

| Laravel | kay |
| --- | --- |
| A queued job | `queue` from `kay/server`, with retries |
| `$schedule->daily()` | `schedule('@daily', job)` from `kay/server` |
| A long-running worker | `background(work)` from `kay/server` |
| Mailables and Markdown mail | [kayjs-mail](/libraries/kayjs-mail): a mail is a `.kay` component, sent with `enqueue` or `send` |
| `Storage::put()` | `files.put()` from `kay/server`, see [File storage](/guides/file-storage) |
| `Cache::remember()` | `cached(key, ttl, load)` from `kay/cache` |
| `.env` and `config()` | `defineEnv` in `src/env.ts` |
| Broadcasting | Server-sent events and websockets in an API route |
| `php artisan` | The `kay` command, see the [CLI reference](/reference/cli) |
| PHPUnit and Pest | `bun test` with `kay/test`, see [Testing](/guides/testing) |

See [Background jobs](/guides/background-jobs).

## What kay leaves to you

- **An ORM and migrations.** kay has neither. The app template of `kay new` uses `@kaynooo/pg-orm` for its tables, and any library that runs on Bun works.
- **Eloquent relations, model events and factories.** They belong to the ORM you pick.
- **Livewire and Inertia.** A page that reacts to the user has [islands](/essentials/islands), written in `.kay`.
- **PHP.** A server runs on Bun, as a process or an executable from `kay build --compile`. See [Deployment](/guides/deployment).
