// The attributes holding a URL a page links to or loads, where a `javascript:` value would run as script and a path of the site goes under its base; `data` is an `object`'s, `srcset` holds several and is handled apart. HTML reads their names in any case.
export const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']
