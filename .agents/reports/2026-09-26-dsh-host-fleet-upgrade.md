# DSH host fleet upgrade: Mac, theshop, mama

Date: 2026-09-26. Mode: host state change, no upstream PR.

## Target selection

Canonical upstream: `https://github.com/deepseek-ai/deepseek-harness` (`origin` on every host checkout).
`gh-axi release list -R deepseek-ai/deepseek-harness` returns 10 releases, all `prerelease: yes`; no stable release exists for this developer-preview project.
Newest release: **`dsh-v0.1.7-rc.2`** (commit `477b4f420553e8a52c2fbccc464d7561b239c443`, published 2026-09-24, == upstream `master` HEAD).
All three hosts ran release-candidate `0.1.5-rc.2` and now run release-candidate `0.1.7-rc.2`: **no host changed channel**, and the prerelease was chosen only because stable does not exist upstream.

## Per-host result

| Host | Before | After | Service (identity / restart) | Rollback identity |
| --- | --- | --- | --- | --- |
| Mac (this machine) | `0.1.5-rc.2` @ `fb2c4b9e69`, `~/projects/tools/deepseek-harness`, **dirty** (captain WIP) | `0.1.7-rc.2` @ `477b4f4205` (detached), checkout clean except pre-existing untracked `.dsh-debug/`, `.generated-model-*` | launchd agent `com.art.dsh-web` (plist `~/Library/LaunchAgents/com.art.dsh-web.plist`), restarted with `launchctl kickstart -k gui/$(id -u)/com.art.dsh-web` | `dsh-v0.1.5-rc.2` / `fb2c4b9e69` |
| theshop | `0.1.5-rc.2` @ `fb2c4b9e69`, `~/projects/tools/dsh-0.1.5`, clean | `0.1.7-rc.2` @ `477b4f4205` | user unit `dsh-web.service` (ExecStart `~/.local/bin/dsh web --port 3099`), restarted with `systemctl --user restart dsh-web.service` | `dsh-v0.1.5-rc.2` / `fb2c4b9e69` |
| mama | `0.1.5-rc.2` @ `fb2c4b9e69`, `~/projects/tools/dsh-0.1.5`, clean | `0.1.7-rc.2` @ `477b4f4205` | user unit `dsh-web.service` (ExecStart `~/.local/bin/dsh web --port 3080`, override `--host 127.0.0.1`), restarted with `systemctl --user restart dsh-web.service` | `dsh-v0.1.5-rc.2` / `fb2c4b9e69` |

The Mac checkout's WIP was committed on the captain's branch as authorized: WIP commit `12c2f51c1a` ("wip: session persistence ownership guard and user-patches tests") on `fix/launcher-readiness-on-tree-death`, then `dsh-v0.1.7-rc.2` **merged into** (not rebased over) that branch as `bafd787056`; the single conflicted hunk (his added test vs. no upstream change at that spot) resolved by keeping his test. Pushed to his fork `kesslerio/deepseek-harness` as a new branch, plain push, no force. The deployment then checked the tag out detached, exactly like the two remotes.

## Procedure actually used

Project documents a source deployment (README "Run from source": `pnpm install` + `pnpm run build`); no self-updater exists. Per host: `git fetch origin --tags` → `git checkout --detach dsh-v0.1.7-rc.2` → remove stale build residue (untracked `lib/` outputs, `*.tsbuildinfo`, 12 orphan package directories from the 0.1.5 layout, keeping every directory that holds a `package.json`) → `rm -rf node_modules; pnpm install --frozen-lockfile` → `pnpm run build` → restart the service above.

`pnpm run clean` was unusable at this tag: 0.1.7-rc.2's `scripts/clean.ts` throws `clean: expected TypeScript outDir to end in /types: lib/desktop-keyboard-test-types` on a pristine tree (that config is reachable from the root solution). The manual residue removal reproduced what `clean` defines as known orphan entries. Without it, tsdown's workspace pass fails with `[@deepseek-ai/dsh-root] Cannot find entry` on the 0.1.5-era trees.

Session data: `SESSION_FORMAT_VERSION` moved 3 → 4 between the tags and 0.1.7-rc.2 ships the adjacent `session-format-v3-to-v4` migration (added in `8dc1d0e3ed`); no manual migration step was needed and existing sessions load (see browser evidence).

## Verification actually performed

- Version readback through the resolved command path, fresh shell, on the serving host:
  - theshop: `bash -lc "DSH_SOURCE_DIR=$HOME/projects/tools/dsh-0.1.5 dsh --version"` → `0.1.7-rc.2`; `type -a dsh` resolves `~/.local/bin/dsh` first.
  - mama: same command → `0.1.7-rc.2`; `~/.local/bin/dsh` is the only entry.
  - Mac: `zsh -lc "command -v dsh; dsh --version"` → `/Users/kesslerio/.local/bin/dsh` (first on PATH, no older copy earlier), `0.1.7-rc.2`.
- Web endpoint rendered through the tailnet in a real browser (agent-browser), not just HTTP codes:
  - `https://theshop.tail24e2e0.ts.net/?token=…` → token handshake 303+cookie → page renders the app shell with the version badge **`0.1.7-rc.2-477b4f4`**, workspaces `theshop-automations`/`art`, historical sessions listed, composer + model picker present; the "Internal Testing Notice" Continue click was accepted and re-rendered the UI.
  - `https://mama.tail24e2e0.ts.net/?token=…` → same flow, badge **`0.1.7-rc.2-477b4f4`**, workspace `mama-automations`, sessions listed.
  - Mac local endpoint `http://127.0.0.1:3099/?token=…` (launchd agent is loopback-only): handshake 200 + `<title>DSH Local Build</title>`.
- Both remote user units report `active`; the Mac launchd entry shows a live PID listening on `127.0.0.1:3099`.

## Caveats and follow-ups worth knowing

1. **theshop runtime PATH**: the stock nixpkgs `node` 22.21.1 on theshop is rejected by 0.1.7's `node-addon-require-builtin@0.1.6` probe (`Unsupported/no-getter`), and boot aborts. Added drop-in `~/.config/systemd/user/dsh-web.service.d/30-node-runtime.conf` prepends a user-local stock node **v22.23.1** (`~/opt/node-v22.23.1-linux-x64/bin`, downloaded from nodejs.org) to the service PATH — the unit already pinned PATH via `20-boot-path.conf`, so this follows the existing pattern and removes cleanly. **Interactive `dsh` on theshop stays broken** until a recognized node is earlier in the login PATH (or nixpkgs' node is upgraded); only the service got the drop-in.
2. **`/dsh` route is gone**: 0.1.7 serves the app at `/` with the `?token=` handshake (303 + authority-bound cookie). The Mac helper scripts `~/.local/bin/dshmama` and `~/.local/bin/dshtosh` still open `/dsh` and will now get 404 pages — a one-line path change each, left to their owner.
3. 0.1.7 enforces the trusted-host list: `curl` from the host itself against `127.0.0.1` 401s unless the `Host:` header matches `--trusted-host`; tailnet hostnames are trusted, which is how the endpoints are actually used.
4. Upstream bugs hit during upgrade (report-worthy, fixed nothing in-tree): `scripts/clean.ts` outDir throw on a pristine 0.1.7-rc.2 tree, and the host tsdown pass failing on leftover 0.1.5 package directories (git-invisible, `clean` would normally remove them).
5. Opportunistic readback requested on theshop: **`tasks-axi` = 0.2.5** at `~/.local/bin/tasks-axi`. The transient `/usr/bin/dsh` + `/bin/dsh` entries seen once via `type -a` are not present on disk (checked twice, ENOENT); the login-shell resolution order is `~/.local/bin` first regardless.
6. Mac curl 401s during testing were stale tokens read from the append-only launchd log, not auth regressions; a fresh-boot token completed the handshake at 200.

All three hosts updated; fleet is uniform on `0.1.7-rc.2`.
