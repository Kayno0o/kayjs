// A notification the `Bell` lists: what kayjs-auth's inbox answers, and what an app's own source gives it.
export interface BellItem {
  id: string
  title: string
  read?: boolean | undefined
  // A path of the site or an http(s) URL; anything else draws the row as a button.
  url?: string | undefined
}

// The notifications of an app's own source: a list, or a function answering one, called once the Bell is in the page and again after a read.
export type BellItems<Item extends BellItem = BellItem> = readonly Item[] | (() => PromiseLike<readonly Item[]> | readonly Item[])
