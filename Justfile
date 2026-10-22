lint-actions: # needs actionlint on the PATH
	actionlint -config-file actionlint.yaml .forgejo/workflows/*.yml

patch: (release "patch") # v0.0.X

minor: (release "minor") # v0.X.0

major: (release "major") # vX.0.0

# bump kay and every library to one version, then push the branch and its new tag in one atomic push and wait for their runs and the registry (ft release); a rejected push drops the bump so a retry starts clean
release level:
	#!/usr/bin/env bash
	set -euo pipefail
	# A release is cut from main as origin has it, so the tag names what CI tested and nothing local rides along.
	[ "$(git branch --show-current)" = main ] || { echo "release runs on main, not $(git branch --show-current)" >&2; exit 1; }
	git fetch -q origin main
	[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main differs from origin/main: pull or land first" >&2; exit 1; }
	bun scripts/version.ts {{level}}
	# A deprecation past its three minors fails only once the version moves, so it is caught here rather than on the tag's CI.
	if ! bun test tests/upgrade.test.ts; then
	  git tag -d "$(git tag --points-at HEAD)"
	  git reset --keep HEAD~1
	  exit 1
	fi
	ft release --tagged

# land this branch on main: rebased on origin's, checked, the tests its changes reach, pushed; landings verify side by side and take turns only to push, one that finds main moved verifying again; one line per step, their output in the git folder's land.log
land:
	bun scripts/land.ts

# wait for the CI run covering a commit on main, origin's tip by default, printing what failed
ci sha="":
	ft ci {{sha}} --workflow test.yml --job test

worktree name: # a worktree at HEAD in .claude/worktrees/<name>, its dependencies installed, as Claude Code's own are made
	bun .claude/hooks/worktree.ts create {{name}}

extension: # build kay.vsix and install it in code-server, which has to be on the PATH
	cd editors/vscode && bun run package
	code-server --install-extension editors/vscode/kay.vsix
