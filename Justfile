lint-actions: # needs actionlint on the PATH
	actionlint -config-file actionlint.yaml .forgejo/workflows/*.yml

patch: (release "patch") # v0.0.X

minor: (release "minor") # v0.X.0

major: (release "major") # vX.0.0

# bump kay and every library to one version, then push the branch and its new tag in one atomic push; a rejected push drops the bump so a retry starts clean
release level:
	#!/usr/bin/env bash
	set -euo pipefail
	# A release is cut from main as origin has it, so the tag names what CI tested and nothing local rides along.
	[ "$(git branch --show-current)" = main ] || { echo "release runs on main, not $(git branch --show-current)" >&2; exit 1; }
	git fetch -q origin main
	[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main differs from origin/main: pull or land first" >&2; exit 1; }
	bun scripts/version.ts {{level}}
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

# land this branch on main: rebased on origin's, checked, the tests its changes reach, pushed; one landing at a time, a second one waiting for the first; one line per step, their output in the git folder's land.log
land:
	#!/usr/bin/env bash
	set -euo pipefail
	exec 9>"$(git rev-parse --git-common-dir)/kay-land.lock"
	flock -n 9 || { echo "waiting for another landing to finish"; flock 9; }
	# Only this shell holds the lock: a process the landing leaves running must not keep it.
	bun scripts/land.ts 9>&-

# wait for the CI run covering a commit on main, origin's tip by default, printing what failed
ci sha="":
	bun scripts/ci.ts {{sha}}

worktree name: # a worktree at HEAD in .claude/worktrees/<name>, its dependencies installed, as Claude Code's own are made
	bun .claude/hooks/worktree.ts create {{name}}

extension: # build kay.vsix and install it in code-server, which has to be on the PATH
	cd editors/vscode && bun run package
	code-server --install-extension editors/vscode/kay.vsix
