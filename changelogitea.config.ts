export default {
  baseUrl: 'git.kaynooo.fr',
  // The libraries' histories came in as merges under packages/: a release lists the merge, not every commit it brought.
  firstParent: true,
  // The notes and the Discord post open with the release's section of the What's new page.
  highlights: {
    file: 'docs/src/content/docs/guides/whats-new.md',
    url: 'https://kayjs.kaynooo.fr/guides/whats-new',
  },
}
