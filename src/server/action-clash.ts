// Apart from `./actions` so `kay check` reports it without loading the server.
// Two files whose paths differ only where a URL keeps neither, `a b.kay` and `a_b.kay`, serve their actions at one URL.
export function actionClash(first: string, second: string, url: string): Error {
  return new Error(`kay: ${first} and ${second} both export an action served at ${url}; rename one of the files`)
}
