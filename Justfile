lint-actions: # needs actionlint on the PATH
	actionlint -config-file actionlint.yaml .forgejo/workflows/*.yml

patch: (release "patch") # v0.0.X

minor: (release "minor") # v0.X.0

major: (release "major") # vX.0.0

# bump, then push the branch and its new tag in one atomic push; a rejected push drops the bump so a retry starts clean
release level:
	#!/usr/bin/env bash
	set -euo pipefail
	bun pm version {{level}}
	tag=$(git tag --points-at HEAD)
	before=$(tea actions runs ls -o json --limit 1 | jq -r '.[0].id // 0')
	if ! git push --atomic origin HEAD "$tag"; then
	  git tag -d "$tag"
	  git reset --keep HEAD~1
	  exit 1
	fi
	just watch-runs "$before"

# wait for the Forgejo runs started after run <after>, failing on the first one that fails
watch-runs after:
	#!/usr/bin/env bash
	set -euo pipefail
	for _ in $(seq 1 90); do
	  # Sleeping first gives a push's runs time to all appear, so one finishing early is not taken for the lot.
	  sleep 10
	  runs=$(tea actions runs ls -o json --limit 10 | jq -c --argjson after {{after}} '[.[] | select((.id | tonumber) > $after) | {id, status}]')
	  if jq -e 'any(.status == "failure" or .status == "cancelled")' <<<"$runs" >/dev/null; then
	    echo "a run failed: $runs" >&2
	    exit 1
	  fi
	  if jq -e 'length > 0 and all(.status == "success" or .status == "skipped")' <<<"$runs" >/dev/null; then
	    echo "every run passed: $runs"
	    exit 0
	  fi
	done
	echo "the runs did not finish in 15 minutes: $runs" >&2
	exit 1

worktree name: # a worktree at HEAD in .claude/worktrees/<name>, its dependencies installed, as Claude Code's own are made
	bun .claude/hooks/worktree.ts create {{name}}

extension: # build kay.vsix and install it in code-server, which has to be on the PATH
	cd editors/vscode && bun run package
	code-server --install-extension editors/vscode/kay.vsix
