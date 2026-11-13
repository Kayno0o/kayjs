#!/bin/sh
# Publishes kay and each library not marked private, from the repository root, to the registry given: `publish-packages.sh <registry url>`.
# A package already on it at its version is skipped, so a rerun after a partial failure publishes the rest.
# A project `.npmrc` or a `publishConfig` naming another registry for `@kayjs` beats the `~/.npmrc` the workflow wrote, so the release stops rather than publish, or read a version, from the wrong one.
set -eu

registry="$1"

wrong=$(cat .npmrc packages/*/.npmrc 2>/dev/null | grep '^@kayjs:registry=' | grep -vxF "@kayjs:registry=$registry" || true)
if [ -n "$wrong" ]; then
  echo "A project .npmrc sends @kayjs elsewhere than $registry: $wrong"
  exit 1
fi

for manifest in package.json packages/*/package.json; do
  configured=$(jq -r '.publishConfig.registry // empty' "$manifest")
  if [ -n "$configured" ] && [ "$configured" != "$registry" ]; then
    echo "$manifest publishes to $configured, not $registry"
    exit 1
  fi
done

publish() {
  package="$(jq -r '.name + "@" + .version' package.json)"
  if bun pm view "$package" version > /dev/null 2>&1; then
    echo "$package is already published"
  else
    bun publish --access public
  fi
}

publish
for dir in packages/*/; do
  [ "$(jq -r '.private // false' "$dir/package.json")" = true ] || (cd "$dir" && publish) || exit 1
done
