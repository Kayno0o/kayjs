---
title: kayjs-cms
order: 4
description: Edit a kay site's content on the page it renders, and manage each collection from screens generated from its schema.
---
`@kaynooo/kayjs-cms` edits a kay site's [content collections](/guides/content) in two ways. Edit mode opens the real page: click a title, edit it in a sidebar, and the page updates as you type. The screens, generated from each collection's schema, list, search, add, edit, publish and delete entries.

Both save the same way. A file entry is a Forgejo commit, or a change in the working tree under `kay dev`. A loaded entry goes through its collection's loader.

## Install

```sh
bun add @kaynooo/kayjs-cms @kaynooo/kayjs-ui @iconify-json/tabler
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay and kayjs-ui are peers. The editor is drawn with kayjs-ui, so the app imports [its theme](/libraries/kayjs-ui#theme). kayjs-cms is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

In a kay project, `kay add cms` installs the packages and adds the extension below with its defaults. Otherwise, put `cms()` in `kay.config.ts`'s `extensions`.

```ts
import { auth } from '@kaynooo/kayjs-auth'
import { cms } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [
    auth({ module: './src/auth' }),
    // Who may use the screens and save: the kayjs-auth users with this role. Edit mode alone only reads.
    cms({ role: 'editor' }),
  ],
  // Edit mode is kay's preview mode; its cookie is signed with a key derived from KAY_SECRET.
  preview: {},
})
```

The screens live at `/admin`. Set `prefix` to move them, to `/` if the site is only the screens. At `/` the screens keep their own chrome and guard even when your app has a root layout or guard: they mount in a `(admin)` group, which adds nothing to a URL. They stay closed without a `guard`. They fit a phone, so a client can edit from one: the entry lists stack as cards and the controls stay big enough to tap.

`role` asks kayjs-auth, as `requireUser({ require: 'editor' })` does. Your app's `authorize` policy decides, as it does for `auth.guard()`. Without kayjs-auth, every request is refused and the server logs why.

`guard` is the other way to say who gets in, and you give one or the other. It takes a guard loaded on the first request, `{ load: async () => (await import('./src/auth')).auth.guard({ require: 'editor' }) }`, so `kay.config.ts` imports nothing of the app's auth or database. It also takes the built guard itself. Then `kay.config.ts` imports `./src/auth`, and with it the app's database, for every `kay build` and `kay check`.

Without `files`, saves go to the working tree, which suits `kay dev`. A production server without it commits them to Forgejo, through `forgejo()` built from `CMS_BASE_URL`, `CMS_REPO`, `CMS_TOKEN` and the optional `CMS_BRANCH`. `kay env` lists them. With none of them set, the server refuses to boot, as the next deploy would drop its saves.

## Signing in and roles

A visitor the guard turns away as anonymous lands on a sign-in screen, not a bare 403, and comes back to the exact page they asked for, query included. The screen is the sign-in page of kayjs-auth when the app has one, or the cms's own when the guard is `passwordGuard`.

For a small site with no members, `passwordGuard` is the whole setup. It takes one password, or one per role:

```ts
import { cms, passwordGuard } from '@kaynooo/kayjs-cms'

cms({ guard: passwordGuard(env.EDITOR_PASSWORD) })
cms({ guard: passwordGuard({ editor: env.EDITOR_PASSWORD, admin: env.ADMIN_PASSWORD }, { maxAge: '30d' }) })
```

A lone password signs in as `editor`. The sign-in lasts 14 days unless `maxAge` says otherwise, and it is a signed cookie, so changing a password signs out everyone who used it. 

Pass `{ secret }` with a secret of your own to tie the sign-in to your site, and set kay's `proxy` option behind a proxy, as the ten tries are counted per client address.

Signing out deletes the cookie and ends it on the server, so a copy of it stops working too. That is kept in memory: another server process, or a restart, still accepts a copy until it expires or the password changes. An empty password throws, so an unset environment variable never opens the admin. The sign-in screen at `<prefix>/sign-in` allows ten tries every quarter of an hour.

A test signs a site in without the form, saves an entry and reads it back, with `cmsTest(site)` from `@kaynooo/kayjs-cms/test`:

```ts
import { cmsSignInAs, cmsSignInWith, cmsSignOut, cmsTest } from '@kaynooo/kayjs-cms/test'

const editor = cmsTest(site)

await editor.signInAs('admin') // the role may be left out when the guard holds one password
await editor.save('posts', 'hello', { title: 'Hello' }, { create: true })
expect((await editor.entry('posts', 'hello'))?.data.title).toBe('Hello')
editor.signOut()
expect((await cmsSignInWith(site, 'wrong')).status).toBe(401)
```

Saves go to the content the test site holds, never to the project's `src/content`. `cmsSignInAs(site, role)` and `cmsSignOut(site)` do the sign-in alone.

The admin header shows who is signed in, a username or an email with kayjs-auth and the role with `passwordGuard`, and a Sign out button.

By default everyone the guard admits can do everything. `roles` limits what a role may do beyond editing:

```ts
cms({
  guard: auth.guard({ require: 'staff' }),
  roles: { staff: [], publisher: ['publish'], admin: ['publish', 'delete', 'upload', 'redirects'] },
})
```

The actions are `publish` (publish, unpublish, and any save that changes the draft flag or a publish or unpublish date), `delete` (entries and unused uploads), `upload` and `redirects` (the missing pages screen and its API).

A person's roles add up, and one whose roles are not listed can only edit. With kayjs-auth the roles are the user's, with its hierarchy, so `admin` holding `editor` counts. A refused action answers 403 and says which action the role lacks. The screens show its button disabled, with that sentence as a tooltip. A role without `publish` sees the draft flag and the publish and end dates of an entry read-only, and one without `upload` gets no image drop or paste in a Markdown box.

A role without `publish` can still add an entry to a collection that has a publish date and no draft flag. The server holds it back with a far publish date until a publisher sets one.

A guard of your own, neither kayjs-auth nor `passwordGuard`, holds no role until `member` says who it let in. It also runs on screens the guard does not cover, so it returns nothing for a visitor who is not signed in. When given, it replaces kayjs-auth's lookup and never falls back to it:

```ts
cms({
  guard: myGuard,
  roles: { publisher: ['publish'] },
  member: ({ locals }) => locals.user && { name: locals.user.email, roles: locals.user.roles },
})
```

If the sign-in ends while an editor is typing, the save says the session ended instead of "Could not save", keeps the edits, and offers a link to sign in again in a new tab. Come back to the first tab and save again.

## Edit mode

In edit mode, kay renders the editor at the end of every page, with the entries the page read, in the order the page shows them, so the forms stay in place as you type. The "Edit on page" links on the screens put an editor the guard admitted in edit mode. The editor's "Stop editing" button leaves it. With changes not saved, it asks first: Keep editing, or Drop them and stop.

Each entry in the editor has Publish (or Unpublish, behind a confirmation) when its collection has a draft flag, and Delete unless the collection is a single one. Publish and Unpublish change only that flag, so with edits not saved they ask you to save first and write nothing. A role that may not publish or delete sees the button disabled, with the reason as its tooltip.

Delete asks first, names the entries that refer to this one, and locks the form once the entry is gone. It then reads the page again. When the page you are on is the deleted entry's own, it opens the collection's screen in the admin instead, as that page no longer exists.

If you decline to leave because other entries hold edits not saved, the form is replaced by a notice with a link to that screen. A save started while the Delete confirmation is open leaves it open, with its confirm button disabled until the save ends.

### Typing on the page

Click a one-line text on the page and type in it where it stands, with no form to find. The text is edited as plain text: what you type or paste stays text, never markup, and a line break becomes a space. Enter keeps the text and ends the edit, as does a click elsewhere, and Escape puts back the text from before. Switching to another window does not end it.

Tab reaches a marked text and Enter starts the edit. The form beside the page shows each keystroke, and the page keeps the text you are typing while it renders the draft again.

This works for a text that is the whole content of its element, in an entry, a group, a block or a list of texts, in any locale. A field the page shows inside a longer text, in an attribute, with other formatting around it or as a Markdown body is still brought up in the form by a click, as is any other kind of field. The schema's length and pattern show their message under the text as you type, and a screen reader reads it out. The editor's code is only sent in edit mode.

### Finding the fields

Hover a field on the page and a dashed box shows it, whether the page shows it as a text, in an attribute such as an image's `src`, or inside a longer text. The "Outline every field of the page" button in the editor's header draws a dotted box around all of them at once. On a phone, where there is no hover, the boxes are on from the start. The editor remembers your choice.

Tab reaches each field, and a screen reader says what it edits. When an element holds two fields, such as a text and a link's address, a click asks which one you want, next to where you clicked. Arrow keys move through the choice, Enter picks and Escape closes it.

The "Browse the page" button next to it lets the page's links, menus and tabs work with the editor still open. Press it again to go back to editing.

### Lists on the page

When the page shows a list, such as the tags of a post or the blocks of a home page, point at one of its items and a small toolbar appears just above its top right corner (below it when the item is at the top of the window), never over the item itself. It moves the item up or down, adds a new one after it and removes it. For a list of blocks, Add asks which kind of block.

The toolbar names what it acts on, the list and the item ("Steps: Item 1"), and outlines that item on the page while the pointer or the focus is on it. A list inside an item has its own toolbar, stacked with the toolbar of the item that holds it, each naming its own. An empty list has an "Add to" button where its items would be.

Everything has a keyboard way. Tab to a field in the item, then press Alt and Shift with the up or down arrow to move the item, Alt and Shift with Delete to remove it, or Alt and Shift with Enter to open a menu of what you can do with it. Tab reaches an empty list, and Enter adds its first item. After the last field of an item, Tab goes to its buttons, then on to what follows the item.

The change goes into the entry's draft, the same one the form beside the page edits, so the form and the page agree. A removal shows "Undo" in the editor, and a screen reader is told where an item went. A list at its most items cannot grow, and one at its least cannot shrink.

The focus follows the item that moved or was added. A new item whose text is still empty cannot be seen on the page, so its field in the form takes the focus. A list of an entry whose form has not loaded, or whose draft is not valid yet, is changed in the form.

An entry has such a link when a page shows it. That is the page listing its collection in `prerender` or `sitemap`. For an entry read by its slug, such as a section of the home page, it is the first page without params that reads it. The cms finds that page by rendering those pages once in edit mode, the first time it needs one, and keeps the answer for a few minutes. An entry no page shows has no link.

### Edit this page

A signed-in editor reading the site finds an "Edit this page" button in the bottom left corner of every page, which opens edit mode on it. There is nothing to add to the app, and the pages stay static.

Opening any screen of the admin marks the browser with a `kay_editor` cookie, readable by the page. So does signing in with [kayjs-auth](/libraries/kayjs-auth), which sets its own `kay_user` cookie that the script treats the same way, so an editor sees the button on the first page after signing in.

Every page carries one short script that looks for either cookie, so a visitor without them loads nothing more. With one, the page asks the guard whether the editor is still signed in. If so, the button shows. If not, the cookie is deleted and the button never shows. The button does not show on the admin screens or in edit mode.

With another way of signing in, an editor who never opened the admin sees no button until they open it once.

To place the link yourself, write an `a(data-kcms-edit-page hidden)` in your layout. The cms fills in its address, shows it, and writes its text when it is empty, instead of drawing its own button. `cms({ pageLink: false })` turns the button off, and the hint cookie with it.

The editor never covers the page it edits. From 64rem wide it docks to the right and moves the page's body aside by its width. On a narrower window, and always below 40rem, it is a sheet at the bottom and pads the page by its height, so the page keeps its width and a fixed header at the top stays in view. At the side, the editor starts under a header fixed or sticky across the top of the window, so the header stays visible, and the dev tool's bar and floating drawer sit outside it.

The header it looks for touches the top and is at most 240px tall. One the page adds later is found on the next scroll or resize.

While the page updates, the editor says so in a line screen readers announce. If an entry you edited does not pass its checks, the page shows its saved text until it does, the editor names it, and the other entries keep their preview. Your unsaved edits show again on the next page you open in the site. After a save to a forge, the editor reminds you for five minutes that the live site may still show the old content, also after you leave edit mode and come back.

Drag the editor's inner edge, or focus it and press the arrow keys, to resize it. The button in its head docks it to the other edge, and the hide button folds it into one button. It remembers the edge, the size and whether it is hidden in the browser.

What you type is kept in the browser, so a reload, a crash or a second tab brings it back with a note saying so. Save, Reset and Stop editing clear it. A draft is kept a week at most, and one made from an older copy of the entry than the saved one is left out with a note, so it never writes over a newer save. Reloading, closing the tab or following a link with changes not saved asks first.

Stop editing clears every kept draft of the browser, but a draft left by a visit that ended another way stays until the week passes, and the edit cookie names no user, so on a browser several people sign in to, they should leave with Stop editing. Where the browser gives no storage, edits are only kept until the page closes.

When the dev tool is docked to the right or the bottom, the editor sits beside it instead of under it. Clicking an element of the page scrolls it above the sheet when the sheet would hide it.

An edit cookie or link is tied to no user, so it reads only the entries the pages it showed in edit mode read, never a customer or order collection the page does not render. A signed-in editor the guard admits reads any entry. The list of those entries lives in the server's memory, so after a restart, or on another replica, load the page again.

Once there is a guard, every save needs it, edit mode included. Without one, saving from an edit link works under `kay dev` only: any other server refuses every save, publish, delete and upload from an edit cookie or link, and warns at boot to set `cms({ role })` or `cms({ guard })`. With a guard, `author` names who a save is committed as, such as the signed-in user.

Without `author`, the forge commits as the account behind its token, so no editor's name or email reaches git. Give `author` the real name and email only when the editors agree to appear in the history: a commit cannot be erased from it later, so a request to delete someone's data (RGPD art. 17) cannot reach their name there. A pseudonym keeps the history useful and the editor private:

```ts
author: async ({ locals }) => {
  const user = await locals.auth.user()
  return user && { name: `Editor ${user.id}`, email: `${user.id}@users.noreply.example.com` }
}
```

## Who else has an entry open

The screen of a saved entry says when someone else has the same entry open, so two editors do not overwrite each other. It names them when `author` gives a name, which is the name the other editor sees for you too, and only counts them when it does not: "1 other editor". The same editor in two tabs is not listed to themselves. A new entry shows nothing, as no one else can have it open.

The editor on a page shows the same line above its form, in the warning colour. It asks no `author`, so it counts its editors. The entry list marks an entry "Being edited", by name when the editors have one.

A list watches through a room of its own, so it is no editor of the entry to anyone, and it marks the first 50 rows of a page. It also shows "Being edited" for your own other tab on the page editor. A named editor is told of editors without a name as "1 other editor". Every open tab on one of these holds a live connection, so a browser on HTTP/1 allows a host only a few.

A screen of your own built from the parts shows the same list by passing `presence` to `EntryEditor`, or `room` and `member` to `EntryPresence`. `entryPresence(ctx, collection, entry)` from `@kaynooo/kayjs-cms/presence` returns both.

## Collection titles

The screens title a collection with its export's name, humanized: `blogPosts` shows as "Blog posts". A collection can say its own title with the `title` option, which suits a site that is not in English:

```ts
export const produits = collection('src/content/produits', { schema, title: 'Produits' })
```

The name keeps naming the collection's URL, its markers and its upload folder.

A `description` option adds a line under the title, on the collection's list and on its entries, to tell an editor what the collection holds.

## A collection of one entry

Some content is one entry, such as the texts of a home page. Declare the collection `single`, and the admin shows it as that page, not as a list of one row:

```ts
export const home = collection('src/content/home', {
  schema: s.Object({ headline: s.String(), intro: s.String() }),
  title: 'Home page',
  single: true,
  seed: { headline: 'Welcome', intro: '' },
})
```

The content list links to the form, which is titled "Home page". It has no slug field, no New entry and no Delete, and the way back leads to the content list. The entry is saved as `index`. The CMS refuses a second entry or a delete, whoever asks.

`seed` is what the form holds until the entry is written. The first save writes it, so the app seeds nothing by hand. Read the entry in a page with `one()`:

```ts
const { headline } = await home.one()
```

`one()` gives the entry's data, else the `seed`, else `undefined`. With a `seed` it is typed as the data; without one, give it a fallback to get the data typed, `await home.one({ headline: '', intro: '' })`. A single collection cannot be `localized`. If it already holds several entries, such as a list you turned into one, the admin and `one()` show the first and the others are out of its reach, so keep one.

## Renaming an entry

The Rename button in an entry's header changes its slug. Type the new slug and the entry opens under it. The button is off for a collection of one entry and while the form has edits you have not saved. The dialog checks the slug as you type: a slug another entry holds turns Rename off and says why, a new folder is announced, and a refusal of the server shows in the dialog. Each row of the entries list has a Rename button too.

The old address of the page redirects to the new one, with nothing to write in `kay.config.ts`. It works per language and survives a restart, because the redirect joins the ones the Not found screen lists, where you can make it permanent.

Rename twice and both old addresses go straight to the last one. Rename back and the redirect from the address that exists again is removed, so nothing loops.

A folder entry's file is moved and keeps its format. With `forgejo()` it is one commit. A saver of your own needs `move` to allow it. A loaded entry is saved under the new slug and removed from the old one, with its history, and it does not go to the trash.

Every entry that refers to this one in a `reference` field is pointed at the new slug, in lists, groups and blocks, in every language it is written in, in folder and loaded collections alike. The dialog lists them before you rename.

With `forgejo()` they are part of the same commit as the move, and the working tree writes them with it. A saver of your own saves them one by one afterwards, as it does loaded entries, whose save shows in their history. If a folder entry committed with the move was saved meanwhile, the rename is refused and nothing is written. If one saved afterwards cannot be saved, the editor names it so you can change it by hand.

A rename is refused if the new slug is taken or names another place, or if an entry that refers to this one lives in a folder outside the repository.

Entries of a language are paired by `translationKey`, or by the slug without one.

When the collection has a `translationKey` text field and the entry is paired with a translation by its slug, the rename writes the old slug as the entry's `translationKey`, so its translations stay paired. A collection with no such field cannot keep them paired: set a `translationKey` before renaming one language.

A page that refers to a translated entry follows the rename in its own language, and a page with no language follows it only once no other language holds the old slug.

## Ordering entries

A collection listed in a hand-picked order names a number field with `order`:

```ts
export const produits = collection('src/content/produits', { schema: s.Object({ name: s.String(), position: s.Optional(s.Number()) }), order: 'position' })
```

`all()` then lists the entries by that field, those without a number last, and the entry list shows Up and Down on each entry. A move saves the field of the two entries that swap places, so the editor never types a number. If several entries hold the same number, or none, a move numbers the entries from 1. A search hides the buttons, as the rows no longer follow the order.

## Choices

A union of literals or an enum is picked from a list. A literal's `title` is what the list shows, and the value stays what is saved:

```ts
status: s.Union([
  s.Literal('available', { title: 'Disponible' }),
  s.Literal('new', { title: 'Nouveau' }),
  s.Literal('sold', { title: 'Vendu' }),
])
```

A literal with no `title` shows its value.

## Lists

An array field is a list of items. A list of single values, such as strings, shows its label once and then one compact row per item. A list of groups folds each item away under a title, the first text field filled in, or `Item 3` when none is. The list shows how many items it holds, and the `minItems` and `maxItems` of the schema: Add and Duplicate stop at the maximum, Remove at the minimum.

A new item starts from the `default` of the item's schema, and a select with no default stays unpicked.

Up, down, duplicate and remove buttons sit beside an item, and Alt+Shift with the up or down arrow moves it from inside its fields, a multi-line text excepted. Removing an item says so and offers Undo, and focus goes to the item that took its place, or to the new item after Add. A screen reader is told where a moved item landed, such as `Moved Tag to 2 of 3`, or `Moved Item 1 to 2 of 3` in a list whose items are numbered, naming the place the item left. The order saved is the order shown.

A `reference('authors')` field is a menu of that collection's entries. A save is refused for a reference to an entry that does not exist, and deleting an entry names the entries that point at it.

A list also has Add at the top, and a menu to jump to an item once it holds eight or more. A folded item shows how many issues it hides, such as `2 issues`. Reset asks before it drops your unsaved changes.

## How a field is entered

The schema already shapes each control. A string with `format: 'email'` or `'uri'` gets an input of that type and stays on one line, whatever its `maxLength`. A `maxLength` limits the box and shows a counter such as `12 / 254`. `minimum` and `maximum` set the limits of a number. An `integer` takes no decimal point, and the mouse wheel over a number box leaves it instead of changing the figure. Emptying an optional text unsets the field, and a toggle shows its description and its issue.

For what a schema cannot say, wrap the field in `fieldInput()` from `kay/content`:

```ts
import { fieldInput } from 'kay/content'

s.Object({
  price: fieldInput(s.Number({ minimum: 0 }), { suffix: '€', placeholder: '600' }),
  bio: fieldInput(s.String(), { rows: 6 }),
  status: fieldInput(s.Union([s.Literal('draft'), s.Literal('live')]), { labels: { draft: 'Brouillon', live: 'En ligne' } }),
  tags: fieldInput(s.Array(s.String()), { lines: true }),
  linkLabel: fieldInput(s.Optional(s.String()), { when: 'link' }),
})
```

The price is a number, stored as `600`, with the euro sign beside the box. `rows` makes a text a box of that many rows that grows as you type. `labels` names the values of an enum. `lines` enters a list of strings in one box, a line each, and emptying it on an optional field leaves the key out.

`when` shows a field only once a field next to it has a value, and the server warns at boot when no field is next to it; use it on an optional field, and know that a hidden field the schema refuses is shown with its message. `placeholder`, `prefix`, `suffix` and `type` (`'tel'` say) shape a one-line box, and `titleField` names the field of a list's items that heads each one.

## Ready-made kinds

Fields a site rebuilds each time come with the editor's control. Name the kind in the schema, from `kay/content`:

```ts
import tabler from '@iconify-json/tabler/icons.json'
import { colorField, geoField, iconField, linkField, moneyField, tagsField } from 'kay/content'

s.Object({
  accent: colorField(),
  price: moneyField({ currency: 'EUR' }),
  labels: tagsField(),
  cta: linkField(),
  place: geoField(),
  icon: iconField(tabler),
})
```

A colour is picked or typed as `#rrggbb`. Money is a number with the currency's symbol beside the box. Tags are words typed into one box, added with Enter or a comma. A link is a label and an address, a place a latitude and a longitude. An icon is picked from a grid with search, and the icon set stays on the server. A select with many options opens on a search box, and a date has Today and Clear buttons.

## Blocks

A page made of different sections is a list whose items are of several types. Declare each type once with `blocks()` from `kay/content`:

```ts
import { blocks, imageField, markdownField } from 'kay/content'

s.Object({
  sections: blocks({
    hero: s.Object({ heading: s.String({ minLength: 1 }), image: s.Optional(imageField()) }, { title: 'Hero banner' }),
    text: s.Object({ body: markdownField() }),
  }),
})
```

Each key is a block type, and its object holds the fields of that block. An item is stored with a `type` key naming its block, like `{ type: 'hero', heading: 'Welcome' }`. When you read the entry, `section.type === 'hero'` narrows the item to a hero, so `section.heading` is typed.

The editor adds a block by its type, with an Add button for each type at the end of the list and a menu at the top. Each block shows the fields of its own type. Blocks move up and down across types, and can be duplicated or removed, as the items of any list can. In edit mode, clicking a block's text on the page opens that field in the editor, even when its block is folded. A block may not have a field named `type`, since kay keeps it for the block's name.

## Field kinds of your own

A field the admin should edit another way, such as a colour or a rating, is declared in the schema with `customField(kind, schema)` from `kay/content`, and edited by `src/cms/fields/<kind>.kay`. There is nothing to register: the editor bundles every file in that folder.

```ts
import { customField } from 'kay/content'

s.Object({ accent: s.Optional(customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))) })
```

```kay
---
// src/cms/fields/color.kay
import type { CustomFieldProps } from '@kaynooo/kayjs-cms'

const { value, onChange, label } = props<CustomFieldProps>()
---
label {label}
  input(type="color" value={typeof value === 'string' ? value : '#000000'} onInput={event => onChange(event.currentTarget.value)})
```

The component gets `value`, `onChange`, `label`, `hint`, `issue` (why the last save refused the field) and `required`. A save checks the value against the schema alone, so a `pattern` or a union refuses a bad one. A kind with no file is edited as JSON, with a hint naming the file to add in development only, and the server logs a warning at boot for it.

A file added while `kay dev` runs is picked up on the next reload. `customField` refuses the name of a kind the editor has built in, such as `text`, `image` or `reference`.

## Files and images

An image or file field (`imageField()`, `fileField()` from `kay/content`) takes a file dropped or picked. It is stored through kay's [file storage](/guides/file-storage), and the field keeps the path that serves it. The file name is a link that opens it in a new tab, and a Clear button empties the field. An empty field shows a slim drop zone with its button beside it, and under it what the field takes: the types, the size and, for an image, the pixels.

An editor who would rather type a path finds a collapsed Path control, shown while the field is empty or holds an address typed by hand. It takes a path or an `http:` or `https:` address, and refuses any other scheme such as `javascript:` or `data:`. A file the CMS stored needs no path, so the control is not shown for it.

While a file uploads, the field shows a progress bar and a Cancel button. A file that fails is explained under the field, not only in a message that goes away. Save refuses while an upload runs, because the field is not set until it ends, and the browser asks before the page is closed.

Under the zone, Choose an uploaded file lists what the collection's folder already holds, so a file is used again without uploading it twice. If the image cannot be shown, the field says so instead of a broken picture.

An image field can ask more of its files, and pair itself with the fields next to it:

```ts
photo: s.Optional(imageField({ accept: ['image/png', 'image/jpeg'], maxSize: '2mb', minWidth: 800, alt: 'photoAlt', width: 'photoWidth', height: 'photoHeight' })),
photoAlt: s.Optional(s.String()),
photoWidth: s.Optional(s.Integer()),
photoHeight: s.Optional(s.Integer()),
```

`accept`, `maxSize`, `minWidth` and `minHeight` narrow what `uploads` takes for that field alone; the editor checks them before it sends the file. `fileField` takes `accept` and `maxSize`.

The fields named by `alt`, `width` and `height` leave the form. The editor asks for the alt text under the image, previews the image with it, and fills in the width and height of every image uploaded or picked, so a page can give them to `image()`. A text field called `alt` needs no hint: it is the alt text of the first image beside it.

These pairs work for a field of an object, not for the items of a list. An object field is drawn as one block with a rule down its left side.

A list of them, such as `s.Array(imageField())`, has a zone of its own that takes several files at once: each is uploaded in turn and added as a new item, in the order given, and a file the server refuses is reported under the zone while the others still land.

An image pasted or dropped into a Markdown body is uploaded the same way and embedded where the cursor is. A refused upload shows a message and leaves the text as it was.

A file field takes PNG, JPEG, WebP, GIF, AVIF and PDF files. Set `uploads` to list others, such as `['image/*', 'application/pdf']`. The file picker offers only those types, and a file over the size limit or of another type is refused, the field telling its type or size, an empty one too.

The server also reads the file's first bytes. A file named `photo.png` that holds a web page, a JPEG or half a header is refused as not a real `image/png`, whatever name or type the browser sent, and the name counts in any case, so `PHOTO.PNG` is a PNG. PDF and SVG files are checked the same way. A type with no signature, such as a CSV, is taken as named.

Storage serves anything but a PNG, JPEG, WebP, GIF, AVIF, video, audio, PDF or plain-text file as a download that cannot run as your site, so an SVG you allow is safe in an `img` and never opens as a page.

An upload may weigh 20 MB by default. `uploads: { types, maxSize }` sets either, `maxSize` in bytes or as a string such as `'50mb'`, for a site of videos or large PDFs, or `'2mb'` for a portfolio that wants less; a part left out keeps its default.

The upload route takes the upload's `maxSize` whatever the app's `maxSize` is, so nothing else is raised. The editor refuses an oversized file before sending it, and the server stays the one that decides. A size that is zero, negative, not a whole number of bytes or over 128 MB less 64 KB stops `kay.config.ts` from loading: Bun refuses a request body over 128 MB before the route sees it, and the upload is buffered in memory.

`pageSize` sets how many entries a collection's list shows on a page, 50 by default.

### Translations

In a site with two locales or more, an entry's screen lists its locales. A locale it has links to that entry, with a Compare link that shows its text beside the form. A locale it lacks links to a new entry that starts as a draft copy of this one, so you translate over the text instead of retyping it.

Under a text still equal to the default locale's, or empty while the default has one, the field says so. The Translations screen at `<prefix>/translations` lists, per collection, the entries missing a locale and the texts not translated yet. A field with a `format`, or wrapped in `untranslated()`, is never asked for.

Every upload goes to one folder shared by all collections, named by the hash of its file, so sending the same file twice stores it once. The media library at `<prefix>/media` lists them with a preview, the size, who sent it and the entries using it, and lets you rename one (the name shown there, never the file's address) or delete one nothing uses. It shows 48 uploads a page and has a search box for the name.

Uploads an older release kept in a folder per collection move over by themselves when the server starts: each one an entry names is copied into the shared folder, and the entries naming it are saved pointing at the copy, through the same saver as any edit (one commit per entry on Forgejo). Nothing changes in the app, though under `kay dev` the first start rewrites the content files that name an older upload.

The old file stays where it was, since pages the site has not rebuilt from still name it; the library hides it and the unused-uploads screen offers it for deletion once no entry names it. An entry that cannot be saved right then is tried again at the next start.

Replacing or removing a file leaves the old upload stored. The unused-uploads screen at `<prefix>/uploads` lists the uploads no entry mentions, and deletes only the ones you confirm, and only with a `guard`.

Check each upload before you confirm. A URL written by hand in a page, or a file outside the collections, is not seen as a use.

<ReadMore href="/llms/kayjs-cms-uploads">Which uploads the unused-uploads screen holds back, and when it lists nothing.</ReadMore>

## Pages visitors cannot find

When a visitor asks a production server for a page it does not have, kay counts the path. The screen at `<prefix>/not-found` lists those paths, the most visited first, with the sites visitors came from, the pages of your own site that linked there, the time of the last visit and, where kay can tell, the page they most likely meant. Paths that a redirect already answers are left out.

A page of your site counts as having linked only when the visit's `Host` is your site's: behind a proxy that does not forward it, only the hosts are kept.

Each path has an Add redirect button: one click for the suggested target, or a box to type the target of a path with no suggestion. The target box offers the pages of your site that hold what you type.

The redirect is saved where the running server reads it, so it answers at once, with no deploy, and the path leaves the list.

Below the list, the redirects added here show Edit, to give a path another target or status, and Remove, which undoes one. A 301 or 302 stored earlier keeps its status when you change only its target. Tick several rows to remove them at once. The redirects of `kay.config.ts` are listed after them, to read. All of it needs the `guard` you gave `cms()`.

A redirect answers with a 307, which browsers do not keep, so Remove undoes it for everyone. Tick Permanent beside Add redirect for a 308 instead: browsers keep it, so Remove does not reach a visitor who has followed it already.

A redirect added here can only go to a page of your site, and kay refuses a loop or a target no page serves. To allow another site, list its host in `runtimeRedirects` in `kay.config.ts`. You can also copy the line into `redirects` in `kay.config.ts`, or run `kay not-found --redirect <path>`, to keep the redirect in the repository.

A path that is gone for good, such as a page you retired, takes Gone instead: it answers 410, which tells search engines to drop it. A 410 has no target.

A path that is only noise, such as a mistyped link from nowhere, takes Dismiss. It leaves the list and comes back if a visitor asks for it again. Clear the list forgets them all.

The target box suggests the pages of your site as you type.

The buttons call `POST /_kay/cms/redirects` with `{ from, to, status }`, where `status` is 307, 308 or 410. `POST /_kay/cms/redirects/remove` takes `{ froms }`, `/dismiss` takes `{ paths }` and `/clear` takes nothing. A refusal comes back as a 400 with its reason. Your own code may call them too, and they need the same `guard`.

## Languages

Every text the screens and the editor show, `Edit this page`, `Save`, `Not valid JSON`, is looked up in your messages before its English. Word them once in `src/messages/<locale>.ts` under `cms`, named for the area and the text, and the screens and the editor read them, the editor in the browser.

```ts
// src/messages/fr.ts
export default defineMessages({
  cms: {
    editor: { title: 'Modifier cette page', stop: 'Arrêter de modifier' },
    admin: { entryCount: { one: '{count} entrée', other: '{count} entrées' } },
  },
})
```

kayjs-cms ships the French of all of them. A site whose locale is `fr` shows French screens and a French editor with nothing declared, and the `fr.ts` above only changes the words you want worded differently. For another language, write the same `cms` block in that locale's file: each key you leave out reads the English.

A key a locale lacks reads the English, and `kay check` leaves the `cms` keys out of its comparison between locales. The API's refusals are worded in the locale of the page that called.

<ReadMore href="/llms/kayjs-cms-words">Every `cms.*` key and its English is in the full kayjs-cms reference, from `media` to `uploads` in [its second part](/llms/kayjs-cms-words-media-to-uploads).</ReadMore>

## Raw HTML in a body

A Markdown body whose HTML would run as the site or cover it is refused on save. That is anything kay's sanitizer drops, such as a `<script>`, an `onclick`, a `style`, a `javascript:` link, or a tag left open for the page around it to close.

List the collection in `rawHtml` to allow it. The collection's own components and HTML shown in a code block are always fine.

## Collections from a loader

A collection whose entries come from a loader has no files to commit. Give it `save` and `remove` beside `load`, and the screens and edit mode write through them.

```ts
export const news = collection({
  name: 'news',
  load: async () => (await listPosts()).map(post => ({ slug: post.slug, data: { title: post.title }, html: post.content })),
  save: async ({ slug, data, create }) => {
    if (create)
      await createPost(slug, data)
    else
      await updatePost(slug, data)
  },
  remove: async ({ slug }) => deletePost(slug),
}, {
  schema: s.Object({ title: s.String() }),
})
```

`create` is `true` for a new entry. Throw then if the entry exists, so another editor's new entry is not overwritten.

kayjs-cms calls them through `saveEntry` and `removeEntry` from `kay/content`, after checking the entry against the schema. Never call those two, nor `saveEntries`, from inside `save`, `saveMany` or `remove` of the same collection, as they wait for each other.

A loader may also give `saveMany(entries)`, which writes the entries of one action together, all or none, such as the two a reorder swaps. Without it they go to `save` one at a time. [A live site with a database](#a-live-site-with-a-database) needs none of this written.

## A live site with a database

Editors saving on a running site need a loader with `save` and `remove`. kayjs-cms ships two, so you write none: `sqliteLoader` on `bun:sqlite` and `pgLoader` on Bun's own `SQL`. Each keeps its entries in one table of JSON, creates it when first used, and adds no dependency.

```ts
import { s } from 'kay'
import { collection } from 'kay/content'
import { sqliteLoader } from '@kaynooo/kayjs-cms/sqlite'

export const posts = collection(sqliteLoader({
  name: 'posts',
  database: 'data/content.db',
  seed: [{ slug: 'hello', data: { title: 'Hello', order: 1 }, body: 'First post.' }],
}), {
  schema: s.Object({ title: s.String(), order: s.Number() }),
  order: 'order',
})
```

For Postgres, import `pgLoader` from `@kaynooo/kayjs-cms/pg` and give it `sql`, a connection URL or a Bun `SQL`. A pg-orm app passes its own connection, `sql: db.sql`, and adds the table to pg-orm's `ignoreTables` (`kay_content` unless you pass `table`), or pg-orm sees it as a table to drop.

The `seed` is your initial content. It is written once per collection, so an entry an editor deletes stays deleted and a new seed never overwrites their work. Several collections can share the table, each keyed by its `name`. Pass `table` to name another.

A reorder saves two entries, and the loader writes them in one transaction: it never half-applies.

To wire the whole thing:

1. Run `kay add cms` and set `preview: {}` in `kay.config.ts`, with `KAY_SECRET` set in production.
2. Declare each editable collection over a loader, as above.
3. Add `cms({ role })` to `extensions`, with the kayjs-auth role of who may edit, or `cms({ guard })` with a guard of your own. A loader needs no `files` saver, which is for folder entries.
4. Keep the database where a deploy leaves it: a volume for the SQLite file, your `DATABASE_URL` for Postgres.
5. Read the collections in your pages as usual. Add `live: true` to the collection so open pages follow a save.

### Other servers and edits made outside the CMS

A save refreshes the collection in the server that handled it. Each loader also looks at its database every second (SQLite) or two (Postgres) and drops the collection's entries when something else changed them. So other servers follow a save, and so does a row you edit with `sqlite3` or `psql`, with nothing to declare. Set `watch` on the loader to change the interval, or `watch: false` to look no more. `ttl` is not needed for this.

The refresh covers the pages that read the collection, the sitemap, `live: true` pages in open tabs and the dates of `publishAt` and `unpublishAt`. A scheduled entry appears on each server's own clock, so replicas need no job. The search index is built by `kay build`, so a new entry is searchable after the next build.

A collection whose entries come from a loader of your own has no database to look at. Call `invalidate()` on it from a webhook route, or restart.

### Bringing back an older version or a deleted entry

A collection kept by `sqliteLoader` or `pgLoader` remembers what editors save. Each entry has a History button: it lists the last 50 saves, newest first, with who made each one, when, and which fields it changed. Restore saves an older version again as a new one, so nothing is lost and the history keeps growing.

You declare nothing for this. The versions sit in the same table as the entries, out of sight of your pages, lists and searches. The collection's list has a Trash button too: an entry you delete is kept there for 30 days, and Restore writes it back under its slug (a draft, for a role that may not publish). A restore is refused if someone saved the entry after you opened it, and a role that may not publish restores without publishing or unpublishing the entry.

`cms({ history: { revisions: 100, trash: '7d' } })` keeps more or fewer saves, or the trash for another time (`trash: false` keeps none), and `cms({ history: false })` turns it off.

To leave one collection out, give it `history: false` in `collections`: `cms({ collections: { notes: { history: false } } })` keeps no revisions and no trash for it.

A loader of your own gets the same by giving a `sibling(kind)` function that returns a loader for a hidden collection in its store. Folder collections keep no history of their own: their files are in git.

### Seeing what editors did

When a collection keeps a history, the content list has an Activity button. It opens one page listing what editors did across the collections, newest first, a page at a time: who, when, and whether the entry was created, saved, published, unpublished, duplicated, deleted, restored or renamed.

Each line links to the entry, except a deleted one. The log keeps the last 500 events of each collection, and a collection left out with `history: false` adds nothing to it.

### Sharing a draft

A draft with a page has a Share preview button. It copies a link that shows that draft, and nothing else, to whoever you send it to. They need no account, and the rest of the site stays as published for them.

The link works for a week and ends if you rename the entry. It needs `preview: { secret }` in `kay.config.ts`, and with `roles` it is a publisher's action. Save your edits first, as the link shows the saved draft.

### After a save

`cms({ onSave })` runs after every save, publish, duplicate, move and delete that went through. It gets the collection, the slug, the locale, what was done (`add`, `update`, `publish`, `unpublish`, `move`, `duplicate`, `rename` or `delete`), the author and, for a folder entry, the commit. A `rename` gives the new slug, and `from` is the old one.

```ts
cms({
  guard,
  onSave: async ({ collection, slug }) => {
    await purgeCdn(`/${collection}/${slug}`)
  },
})
```

It runs in the server that handled the save, before the editor gets the answer, so keep it short. If it throws, the error is logged and the save stays. A hook still running after 10 seconds is logged and the save answers without it.

## Where files are saved

A folder entry is a file, and `files` says where it goes. `forgejo()` commits it. `workingTree()` writes it in place, which is the default under `kay dev`. The token travels with every request, so `forgejo()` throws for a plain `http:` address unless it is `localhost`, `127.0.0.1` or `[::1]`.

A production server refuses to boot on the working tree, as the next deploy would drop its saves. Name `workingTree()` yourself where the files outlive a deploy.

Any `{ save(change) }` is a saver. `change` has the file's `repoPath`, its new `text` (`undefined` to delete it), a commit `message` and the `base` version it was edited from.

```ts
import type { FileSaver } from '@kaynooo/kayjs-cms'
import { fileVersion, SaveConflictError } from '@kaynooo/kayjs-cms'

const saver: FileSaver = {
  async save({ absolute, text, base }) {
    const file = Bun.file(absolute)
    const current = await file.exists() ? fileVersion(await file.bytes()) : null

    if (base !== undefined && base !== current)
      throw new SaveConflictError(current)

    if (text === undefined)
      await file.delete()
    else
      await Bun.write(absolute, text)

    return undefined
  },
}
```

`base` is `null` for a new file and `undefined` to write whatever is there. A saver that finds another version throws `SaveConflictError`, which the editor shows with its Keep my edits button.

A saver may also have `move(move)`, which renames an entry's file. `move.from` and `move.to` hold the `repoPath` and `absolute` path of each, `move.text` is the text the file has at `to`, `move.base` is the version of `from`, and `move.message` and `move.author` are as in a save.

It writes `to`, then removes `from`; `forgejo()` does both in one commit. It throws `SaveConflictError` when `from` is at another version or gone, or when `to` exists (`new SaveConflictError(undefined, true)`). `workingTree()` does it in place. A saver without `move` cannot rename entries.

## The entries API

The editor, the sidebar and the screens change entries through one API under `/_kay/cms/entries/:collection/:slug`. `GET` answers the collection and the entry with its `version`; add `?locale=` for a localized entry. A missing entry is a 404. `POST` saves, `DELETE` deletes, `POST` to `…/publish` publishes a draft and `POST` to `…/unpublish` makes a published one a draft. `POST` to `…/move?direction=up` or `down` reorders.

`POST` to `…/rename` with `{ slug }` and the `?version=` renames the entry, and answers the `unpointed` entries it could not point. `POST` to `…/duplicate` saves a draft copy and answers its `slug`. `GET /_kay/cms/entries/:collection` lists the entries a reference can pick. `POST /_kay/cms/markdown` takes `{ markdown }` and answers the sanitized `{ html }` the editor's Preview shows, with the same guard as a save. kay checks the data against the schema before anything is written.

## Saves and conflicts

Save is disabled until something changed, and Ctrl or Cmd+S saves from anywhere on the screen or in the editor on the page. While a save is on its way the fields are locked. Next to the buttons, a line says where the entry stands: `Saving…`, `Unsaved changes`, or `Saved at 14:32`. When the site shows a save only after it has rebuilt, the line says `Not live yet` and links to the page.

Publish, Unpublish, Publish now and Clear schedule each change one field and save it. With unsaved edits they refuse and ask you to save or cancel them first, so they never save half-typed text. If the save is refused, the form goes back to how it was. Delete names the entry, warns that the page of one that has a page stops answering, and lists the entries that name it in a reference field.

If you decline the question about edits not saved when Delete takes you to the collection, the form is replaced by a notice with a link to the collection.

After a save the site shows only once it has rebuilt, the line by the buttons says `Not live yet` until the public page serves the change, then `Live now`.

A commit shows on the site once it has rebuilt from it. The Forgejo token needs write access to the repository's contents, and the commit is the token's user's.

A save or a delete made over another save is refused rather than writing over it. So is one made over your own save before the site rebuilt from it. The refusal stays on the form, names the fields both sides changed, and offers Take their version, which drops your edits for the saved copy. Its Keep my edits button lets the next save write your edits over that save.

A loaded entry is protected the same way, and your loader does not have to give a version: kayjs-cms compares what the loader returns for the entry now with what the editor opened. If another editor or your app changed it meanwhile, the save or the delete is refused and the form offers Keep my edits. A save that leaves the content as it was does not count as a change.

Only the fields the schema declares are compared, so a loader that adds computed fields, such as a url or a read time, or that changes them on every read, causes no false conflict. A save still sends every field the entry has, so a field the loader changed meanwhile that the schema does not declare is written back as the editor opened it.

Saves and deletes of one collection are checked and written one after the other in the server, but two servers behind one app do not wait for each other.

A loader that returns something new on every read, such as the current time in a field, makes every save conflict, so keep such fields out of the entry. Each save costs the loader two more reads, and a delete one.

A save that takes over 15 seconds (`timeout`), or a forge out of reach, fails with the reason. It says so when the commit may still have gone through.

A repository checked out with CRLF line endings, or using SHA-256 object names, gives files another version than the editor computes, so every save conflicts.

## Fixing a refused save

When the server refuses a save, the form takes you to what is wrong. The focus goes to the first field to fix and the page scrolls to it. Above the form, a list names every field to fix, and each line links to its field. A screen reader hears each field's message once, not the list again. On the page editor the list also holds the problems the preview finds as you type.

Fixing one field clears that field's message and leaves the others. A field the form does not show gets a message of its own above the form, with no link.

The form also checks as you type. A field with a minimum or maximum length, a pattern, or a minimum or maximum number gets the matching limit on its input, and says what is wrong once you leave it. A required field is marked `required` on every control, and a pattern becomes the input's own `pattern` only when it is anchored at both ends (`^...$`) and has no `\p{...}` or `\u{...}` escape and no character beyond the basic plane, since HTML anchors a pattern itself.

The form checks any other pattern. The server still decides on a save.

A JSON box that does not parse blocks the save. It says `Meta is not valid JSON` under the box, and nothing is sent until you fix it. A slug that is already taken is marked on the slug field, and typing another one clears it.

### Writing the slug

On a new entry of a folder collection, the slug writes itself from the title as you type it, so `Été à la ferme` becomes `ete-a-la-ferme`. Latin accents are dropped and letters of other scripts are kept, so `Привет мир` becomes `привет-мир`. Their marks stay too, Greek accents and Arabic vowel signs included.

A title with no letter or digit leaves the slug empty and the box says to type one. Typing in the slug box takes over and turns that off. The checkbox under the box turns it on again, and so does clearing the box.

What you type in the slug box is cleaned as you type: accents go, spaces become dashes and capitals become lowercase. A `/` stays, to put the entry in a folder. A loaded collection keeps the slug as typed.

The slug is marked as taken the moment the collection holds it. Under the box the form says which folder the entry lands in, which folder it creates, and when a new folder looks like a typo of an existing one (`No folder guidse yet: did you mean guides?`). It reads the slugs from `GET /_kay/cms/slugs/:collection`, for signed-in editors only.

## Arranging a collection

The screens read each collection's schema. To change how one looks, name it in `cms({ collections })`:

```ts
cms({ collections: { shop: {
  form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku'] },
  list: { columns: ['price', 'live'], actions: ['delete'] },
} } })
```

In the form, `fields` come first, in that order. A list inside it is a row of columns, which stack where there is no room. The other fields follow in the schema's order, then the Markdown body, which you name `body`. `hide` leaves a field out. A hidden field that a save refuses still shows its message above the form. A name can be a dotted path into a group, `address.street`: that field leaves its group and takes the place named, in a row too, and the group keeps the rest.

The Markdown body is labelled Body, in the editor's language. `body: { label: 'Article', hint: 'Plain text, no HTML' }` in `form` words it for the collection. Setting `body` on a collection that has no Markdown body stops the server at boot and names the collection.

Over every Markdown box, the body and the `markdown` fields, sits a toolbar of bold, italic, heading, lists, link and image buttons. `toolbar: false` removes it and `toolbar: ['bold', 'italic', 'link']` keeps those buttons, in that order.

Each Markdown box also has a Preview button. It shows the text rendered by your site's own Markdown parser, beside the box, or in place of it where there is no room. Nothing in your app is needed for it.

A component shows as its content, code is highlighted by your site's highlighter, and an image written as a path in the entry's folder, such as `./cat.png`, shows from there. `previewClass: 'prose'` in `form` gives the preview the classes your pages style rendered Markdown with. It shows a short reason when the text cannot be read, such as a component left open.

In the list, `columns` are field keys shown after the title, and `actions` keeps some of a row's `move`, `publish`, `unpublish`, `duplicate`, `rename`, `editOnPage` and `delete`. A list, group, JSON or custom field cannot be a column.

To organise the content list, give a collection a `group` and an `order`: `shop: { group: 'Store', order: 1 }`. Collections with no group come first, and each row shows the collection's drafts, when it was last edited and a New entry button. `icon` takes an icon imported from `~icons/<prefix>/<name>`, drawn before the collection: `shop: { icon: cart }`.

The list keeps its state in the URL, so you can send a link to a view. You can search without caring for accents, filter by status, sort any column across every page, including when an entry was last modified and by whom (read from git history), tick entries to publish, unpublish or delete them together, and duplicate or rename an entry.

A new entry has Cancel, and Create and add another, which opens an empty form for the next one. A copy goes last in an ordered collection. In a collection with a publish date and no draft field, the copy is dated 9999-12-31 until you pick a date, so it does not go live at once. When an action fails, the message says why.

The editor on the page follows the form's layout too. A name twice, or an action that does not exist, throws when `kay.config.ts` loads. A field the schema lacks logs a warning at boot.

## Scheduling an entry

A collection with `publishAt: 'publishAt'` (see [Scheduling an entry](/guides/content#scheduling-an-entry)) shows that date field in the entry form like any other. The editor sets, changes or clears it and saves. The cms only edits the field: kay shows the entry at that time, with no job in your app.

In the list, a published entry whose date is ahead has a `Scheduled for` badge in the Status column, and the entry screen shows the same badge. Both name the time in the editor's own time zone, such as `Scheduled for 2026-10-20 10:00 GMT+2`, once the browser says it, and in UTC before. The badge goes by itself when the date passes, back to `Published` in the list. A draft stays a draft, so Publish on a draft with a date confirms the schedule.

Beside the badge, Publish now dates the entry now and Clear schedule removes its date, each saving at once.

A collection with `unpublishAt` also shows an `Ends 2026-10-20 10:00 GMT+2` badge on the entry screen while that date is ahead, and `Ended` once it passes, because the site no longer shows the entry. Clear end date beside it removes the date and saves at once. The date field itself is edited like any other date. In the list, the Status column shows `Ends` beside `Published` while that date is ahead, and `Ended` once it passes, also for a collection with `unpublishAt` alone.

The date and time input shows the time of the editor's own time zone, whatever the server's, and names the zone under the field. What the editor types is stored as the exact moment it names, so an editor in Paris and one in New York see the same entry at their own hours. A time the clocks of the zone skip, on the night they go forward, is stored an hour on. A date field you clear stores nothing.

## Replacing a screen

Write a page at the screen's path, such as `src/routes/admin/collections/shop/[...slug].kay`. It replaces that screen and leaves the others. The cms guard still runs before your page. With `prefix: '/'` the path is under the group, `src/routes/(admin)/collections/shop/[...slug].kay`.

The screens have a chrome of their own, with none of your site's layouts, header or footer around them. It has a skip link, a nav with Content, Missing pages, Media and Unused uploads, and a link back to the site. Every title ends in `Content admin`, which you reword with `cms.admin.brand`.

Give the header a logo in the cms settings: name a module in `kay.config.ts` as `settings: { '@kaynooo/kayjs-cms': './src/cms-settings.ts' }`, and have it default-export `{ ...defaults, logo: { src: '/logo.svg', alt: 'Acme', width: 120, height: 32 } }` (`defaults` and the `Settings` type come from `@kaynooo/kayjs-cms`).

`src` is a file of `public/` or an https URL, shown before the name, and `width`, `height` and `href` are optional (`href` is not used here, as the header links to the admin, and the image is drawn 1.5rem high whatever the size, which only gives its proportions). A `src` that is no path of the site or https URL answers the admin with a 500 naming it. `cms({ logo: '/logo.svg' })` still works until 1.73 and gives an image with no `alt`; the settings win when both are set.

The pages are `noindex`, and they take kayjs-ui's theme, light or dark as the device is, so the app needs Tailwind and its build plugin, as kayjs-ui does. The `seo` and fonts of `kay.config.ts` and your security headers still apply, but not the CSS or head tags your root layout adds.

An entry screen heads its title with crumbs: Content, then the collection, each a link. A `src/routes/admin/_layout.kay` replaces that layout for all the screens. It holds the chrome, the toaster, the tooltip host and the stylesheet `@kaynooo/kayjs-cms/admin.css`. Render kayjs-ui's `Toaster` and `TooltipHost` and import that stylesheet to keep them. Set `export const page = { layouts: false }` in yours to stay clear of the site's layouts as the default does.

In the page, read what the screen reads with `entryScreen`, `listScreen` and `collectionScreen` from `@kaynooo/kayjs-cms`, then render a component of your own, or the screens' own `@kaynooo/kayjs-cms/entry-editor.kay` and `@kaynooo/kayjs-cms/entry-table.kay`.

## Building an entry screen

To arrange an entry screen in a way the layout cannot, build it from the parts the default one is made of. `createEntryForm` from `@kaynooo/kayjs-cms/form` keeps the state: drafts, save, publish, delete, reset and the warning when you leave with edits. Each part takes that `form`.

```kay
---
import type { ScreenCollection, StoredEntry } from '@kaynooo/kayjs-cms'
import EntryActions from '@kaynooo/kayjs-cms/entry-actions.kay'
import EntryField from '@kaynooo/kayjs-cms/entry-field.kay'
import EntryHeader from '@kaynooo/kayjs-cms/entry-header.kay'
import EntryIdentity from '@kaynooo/kayjs-cms/entry-identity.kay'
import EntryNotices from '@kaynooo/kayjs-cms/entry-notices.kay'
import { createEntryForm } from '@kaynooo/kayjs-cms/form'

const { prefix, collection, entry } = props<{ prefix: string, collection: ScreenCollection, entry?: StoredEntry | undefined }>()

const form = createEntryForm({ prefix, collection, entry })
---
form(novalidate onSubmit={event => { event.preventDefault(); void form.save() }})
  EntryHeader(prefix={prefix} collection={collection} title={form.name} subtitle={form.subtitle})
    EntryActions(form={form})
  EntryIdentity(form={form})
  EntryNotices(form={form})
  EntryField(form={form} name="photo")
  EntryField(form={form} name="name")
```

`EntryField` renders one field by its key in the schema, and throws for a key the schema lacks. `EntryBody` renders the Markdown body and `EntryFields` renders everything as the layout arranges it. `EntryNotices` shows a file that does not parse, a refused save with its Keep my edits button, and the messages of any field the screen does not render. Saves, conflicts, uploads and messages work as on the default screen, and the words come from the same `cms.*` keys.

An island marked `persist` keeps its state when the page refreshes in place and takes new props. Give it `entry: () => all.entry`, with `all` being what `props()` returned, and the title, the slug and the file's problem follow the refreshed entry.

## In the dev tool

Under `kay dev`, the dev tool has a CMS tab with nothing to set up. It says whether you are in edit mode. One button takes you into edit mode on the page you are viewing, as long as the guard lets you in, and another leaves it. The tab speaks the page's language, from the `cms.dev.*` words. You can reword them like the other `cms` words.

<ReadMore href="/llms/kayjs-cms">Every option, the CMS API and the rules that are easy to get wrong are in the full kayjs-cms reference.</ReadMore>

## Reference

Topics of the kayjs-cms reference the sections above do not link:

- [Setup and saving files](/llms/kayjs-cms-setup)
- [Options of cms()](/llms/kayjs-cms-options)
- [The editor on the page](/llms/kayjs-cms-editor)
- [The admin screens](/llms/kayjs-cms-admin)
- [Arranging and replacing the screens](/llms/kayjs-cms-screens)
- [History, the trash and the activity log](/llms/kayjs-cms-history)
- [Loaders and a live CMS](/llms/kayjs-cms-loaders)
- [Edit this page link](/llms/kayjs-cms-page-links)
- [Field kinds and entering a field](/llms/kayjs-cms-fields)
- [Form fields and drafts](/llms/kayjs-cms-api)
- [Renaming an entry's slug](/llms/kayjs-cms-rename)
