# Frozen artifact publication

## Drift, 2026-11-25 13:03 HKT

`e8bd0b27ba23cb9dd5e8eba6c4e0847a7c823b05`, `589f30cf`, and the old `668` artifact are not current release baselines. Do not arm, sync, roll back, or write a marker from them. Do not restore an old artifact. The next artifact and rollback baseline has to be a new production snapshot taken after the publish below. This checkout does not have that snapshot, and it does not install or publish.

Remote `main` is `f78a925383e6418159f8a72ad3c929a282d2670c`, parent `e8bd0b27`, subject `backtest: price refresh 2026-11-25`, committer `backtest-prices[bot]` at `2026-11-25T04:59:46Z`. The change is `backtest/data/prices/` only. That SHA is the git tip to preserve. It is not, by itself, an artifact or rollback snapshot. PRs 33, 34, and 35 are open and unmerged. Their heads are not in `main`.

The live entry is `bash /workspace/digest/check_sections.sh`. It compares `git ls-remote` with the first line of `.sections_deployed` and, on a change, runs `publish.sh` with `BUTTONDOWN_SKIP=1`. There is no separate marker program. `publish.sh` is the only writer of `.sections_deployed`.

This package is not installed. Do not run it against `/workspace/digest` from this checkout. `install.sh` and `rollback.sh` refuse that path unless `ADRRR_INSTALL_CONFIRM=1`. Nothing here merges `main`, arms the live host, or publishes.

Deleting `.publish_window_pin` is not how this window goes live, and `abort` does not delete it. Install writes a prearm hold before the patched scripts are renamed. While that hold is in force, every caller of the patched `publish.sh` and `check_sections.sh` fail-closes. The morning assembler returns only after a verified window publish, `release-daily`, and the morning `publish.sh` that consumes the hold.

## Snapshot the patches are based on

Sanitized bytes match the original manifest. No literal secrets, and no config, token, or userdata files were in the snapshot.

| file | snapshot sha256 | mtime (HKT) |
| --- | --- | --- |
| `publish.sh` | `fbc85d30fb90c14ab262d0aa40918617b45df6547616639cfc138e6fe51da6bb` | 2026-11-25 11:51:20 |
| `check_sections.sh` | `293523484f92c3f0267c21b174f0c9efb27383ff91475bce5e486e8c4ddb4820` | 2026-11-25 11:50:49 |
| `tools/latest_json.py` | `aba56c7d5d54587173492d970fe9c7486f421ef438df35d6f71789e8d0d6a338` | 2026-11-25 11:50:44 |
| `tools/og_images.py` | `1758cf46369e84294938f25ea6c4574806525cfff5dd62da30a5dd0e9baac510` | 2026-11-25 11:51:25 |

`validate_wrap_urls.py` is not modified. `build_site.py` was not in the snapshot and the window path does not import it.

An earlier host read showed `/workspace/digest/.sections_deployed` = `e8bd0b27ba23cb9dd5e8eba6c4e0847a7c823b05` at 2026-11-25 11:51:52 HKT. That value is invalidated as a release baseline. This patch does not clear, rewrite, or restore a marker.

## Patched hashes

| file | patched sha256 |
| --- | --- |
| `patched/publish.sh` | `eb9111f2ffff22ad236583af351a4eec2c16c956d4792fd80adbc8d262883b39` |
| `patched/check_sections.sh` | `9ea3b8a7ea1c7e5717afb9a5ac859a59a32544ac66e16fec4748319871f8a004` |
| `patched/tools/latest_json.py` | `59c3b90c8905a0461ec7adf37993f1b0136dd2bd3d495f69a67f68606f91a848` |
| `patched/tools/og_images.py` | `236f0bc028d2adce9776076fc3e8bbde28628402d665ba73e4b188eddc976adb` |
| `publish_window.py` | `67d6243c8724f1cbbca6d4ac2f201df96bc465798276f25c7267b1ca552965d1` |

## Install writes the hold first

`install.sh` takes `$D/.publish.lock` and then:

1. Refuses any live file that is neither the snapshot hash nor the patched hash. That refusal happens before any rename.
2. Writes `.publish_window_bootstrap`, `.publish_window_pin`, and `.publish_window_hold` with `state: prearm`, recording the current `sections-src` HEAD as `baseline_sha` and `HEAD^{tree}` as `baseline_tree`. This write is before the script rename.
3. Copies the previous bytes to `.publish_window_backup/<stamp>/` and renames the patched scripts into place: `publish.sh`, `check_sections.sh`, `tools/latest_json.py`, `tools/og_images.py`, `tools/publish_window.py`.

An in-flight `publish.sh` that already holds the lock finishes the old program. The install waits for that lock, so the rename is not mid-publish. A caller that starts after the rename blocks on the same lock and then runs the new program, which sees the hold. The residual is a process that already passed the old program's lock check before the install waited; the install does not start until that process releases the lock.

`abort` always refuses. It does not delete the pin or the hold, and it does not return the morning assembler. `rollback.sh` also refuses while the pin, the hold, or a prearm bootstrap is present. The backup directory keeps today's snapshot bytes for a later restore, after the morning run has consumed the hold. Copying those bytes back by hand while the hold exists is not a supported exit.

A patched entry with no bootstrap, or with bootstrap `prearm` and no pin, still fail-closes. Absence of the pin is not the daily path.

## Sync the merged tip, then arm

Do this while the hold is `prearm`. The PR head is not the value to pin. GitHub's merge of the approved parents produces a new SHA. `sync` checks out that SHA; it does not assume a fast-forward.

```bash
python3 /workspace/digest/tools/publish_window.py sync \
  --host /workspace/digest \
  --tip "$MERGED_MAIN_SHA"
```

`sync` refuses a dirty `sections-src` before it fetches or resets. It fetches the remote branch, requires `git ls-remote` to equal `--tip`, and requires the recorded baseline to be an ancestor of that tip (`git merge-base --is-ancestor`), so a merge commit with two parents is accepted. It then `git reset --hard` and `git clean -fdx` inside `sections-src` only. It rechecks that remote, local HEAD, and the tip are the same SHA, records `HEAD^{tree}`, and leaves the state at `prearm`. It does not arm and it does not publish.

`arm` then requires all of the following, and refuses otherwise:

- state is still `prearm` and `sync` has recorded a tip
- `sections-src` porcelain is empty
- remote SHA, local HEAD, and the synced tip are equal
- `HEAD^{tree}` equals the synced tree
- the artifact tree is outside the digest, contains public files, and its `functions/` bytes equal `sections-src/functions`
- `--rollback` is a second tree, also outside the digest, with its own public files

```bash
python3 /workspace/digest/tools/publish_window.py arm \
  --host /workspace/digest \
  --artifacts "$APPROVED_TREE" \
  --rollback "$PREVIOUS_PUBLIC_TREE" \
  --rollback-deployment "$PREVIOUS_PRODUCTION_DEPLOYMENT_UUID" \
  --until 2026-11-26T08:00:00+08:00
```

`--rollback-deployment` is optional. When it is present it must be a deployment UUID. The pin stores every file in both trees: `functions/`, `_headers`, `_redirects`, and dotfiles are `inventory-only`. Ordinary pages are `http-verified`. `until` is a deadline. When it passes, the entry fail-closes. It does not fall through to the morning assembler.

`build_site.py` is not in the snapshot. Do not run it for this publication. The approved input is the directory that already contains the exact tree Wrangler should upload.

## One upload, then one restore

Use the real entry:

```bash
bash /workspace/digest/check_sections.sh
```

`check_sections.sh` during prearm, after a failed restore, or after a verified restore exits 3. It does not assemble. `ls-remote` failure exits 3 while the bootstrap is `prearm` or a pin exists. After the morning consume has set the bootstrap to `released` and removed the pin, that same failure prints `WARN: ls-remote failed` and exits 0.

On the armed route, `publish.sh` under the publish lock:

1. Re-checks the pin, the hold, the scripts, the artifact bytes, the local HEAD, and `ls-remote`. No `build_site.py`, no `latest_json.py`, no image refresh, no generator, no `deploy/` swap, no data or cache write.
2. Copies the pinned files, including inventory-only files, into a temp stage.
3. Sets the pin to `upload-attempted` and `restore_required` before Wrangler runs. A crash after that mark cannot be aborted into the morning path.
4. Runs the same Wrangler command as the morning path.
5. Requires Wrangler exit 0, `Deployment complete`, a deployment-specific `https://<id>.<project>.pages.dev` URL, and `Uploading Functions bundle` when `functions/` is in the stage.
6. GETs every public artifact path from that deployment URL and compares SHA-256. `ADRRR_READBACK_ORIGIN` is a test transport only.

Only a matching readback writes `.sections_deployed`:

```
<sections sha>
identity <script_identity> <artifact_identity> <deployment_id>
url https://<id>.<project>.pages.dev
```

The window path does not send mail, even if `BUTTONDOWN_SKIP` is unset. The webhook still passes `BUTTONDOWN_SKIP=1`.

If that new deployment is not verified, the same invocation restores the previous public bytes once:

- With `ADRRR_PAGES_ROLLBACK_LIVE=1` and a rollback deployment UUID, it POSTs the documented Pages endpoint `POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback` ([Cloudflare API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/)). Wrangler has no `pages deployment rollback` command. API success is not treated as proof.
- Otherwise it uploads the pinned rollback tree with the same Wrangler command. The tests use this path, or a local command stub that is given the documented URL. They do not call `api.cloudflare.com`.
- It then GETs the rollback tree's public files and checks the staged inventory locally, including `functions/`, `_headers`, `_redirects`, and dotfiles.

A verified restore sets `restore-verified`, writes no marker, and leaves the hold. The command still exits non-zero because the new tree was not published. The next `check_sections.sh` does not upload again. An explicit `retry-publish` is the only way back to one more upload of the new tree.

A failed restore sets `restore-failed`, writes no marker, prints `EMERGENCY`, and does not loop. The only continuation is `restore --explicit`. That command is capped. Neither path writes a fake marker.

A second invocation whose scripts, artifact bytes, and public bytes still match a committed deployment is a no-op. The no-op key is the sections SHA plus the script identity plus the artifact identity plus the read-back bytes. If the public bytes differ after that commit, the entry fail-closes and does not upload again. A readback transport failure exits non-zero and does not upload.

## Return to the morning run

After the marker identity is in place and a replay reads back clean:

```bash
python3 /workspace/digest/tools/publish_window.py release-daily --host /workspace/digest
```

This does not publish. The next direct `./publish.sh <dated-folder>` is the morning path again: assemble, data JSON rewrite, soft-hero upgrade, mail on the existing weekday rules. `check_sections.sh` between release and that morning run still no-ops on the frozen transaction. It does not assemble. When the morning deploy is verified, `publish.sh` rewrites the marker as the SHA only, sets the bootstrap to `released`, and deletes the pin and the hold. Later webhook calls with the same SHA take the old unchanged exit and do not refresh.

`ADRRR_PUBLISH_MODE=frozen` on that authorized morning `publish.sh` exits 3. It does not build a side tree and it does not refresh.

If both pin and hold are removed while the marker still has an identity line, `check_sections.sh` exits 3. Restore them with `resume --host ... --artifacts <the same tree> --until <future>`. If both are removed before any marker identity while the bootstrap is still `prearm`, the entry stays fail-closed. That is not an abort and it is not the daily path.

## Daily behavior that stays

With bootstrap `released`, no pin, no hold, and a SHA-only marker:

- `check_sections.sh` still exits 0 on `ls-remote` failure, on an empty repo URL, on a missing report folder, and when the remote SHA equals the marker.
- A changed SHA still runs `publish.sh` with `NETLIFY_MIRROR=0` and `BUTTONDOWN_SKIP=1`.
- The morning marker is written only when Wrangler exits 0, the log contains `Deployment complete`, and a present `functions/` directory also produced `Uploading Functions bundle`. Otherwise the script exits 1 and does not write the marker or send mail.
- `latest_json.py` failure still warns and the news tree still deploys.
- `home-preview`, `seo-meta`, `news-feed`, and `build-sitemap` still warn and continue.
- IndexNow and Buttondown failures after a verified morning marker still warn.
- The opt-in Netlify mirror still ends in `|| true` and stays off unless `NETLIFY_MIRROR=1`.
- The wrap-URL gate and the sections SHA mismatch still exit before assemble.

## Repository order

PR 34 is the portrait contract. PR 33 is the five Movers names. This package is the publication mechanism. They stay separate reviews. The head that contains all three, with this package's comparison base on the Movers-on-portrait branch, is the tip whose existing `check` job is the remote gate. A local combination is not that gate. The `window-tests` job runs this suite on its own and does not change the `check` job.

## Tests

From the repo root, with no `ADRRR_HOST_ROOT` pointed at the live digest:

```bash
bash scripts/host-window/run-tests.sh
```

The script runs `python3 -m unittest scripts.tests.test_publish_window -v` under `strace` and exits non-zero if the trace opens `/workspace/digest` or connects outside loopback. It does not hide or move a production digest. The tests themselves pass `ADRRR_HOST_ROOT` only to their temp directories.

## Not proven

- The platform may or may not retry a non-zero `check_sections.sh`. The 30-minute cadence is the script's usage comment, not a captured cron. The installed scripts do not need that retry: the next local invocation sees the hold.
- `build_site.py` is still required by the morning assembler and was not in the snapshot. The window path does not execute it. If the approved artifact directory is missing, arm or the window route fails closed. This package cannot build that tree.
- HTTP readback proves the pinned public file bytes on the deployment-specific URL. It does not prove `functions/`, `_headers`, `_redirects`, or dotfiles, and it cannot see extra files that Wrangler stored but the pin did not list. Those paths are in the artifact identity and in the staged upload. Functions still require the Wrangler bundle line. That line is not a byte-for-byte readback of the worker.
- The documented Pages rollback is the POST above. Tests never set `ADRRR_PAGES_ROLLBACK_LIVE=1` and never call Cloudflare. The fixture proves a stubbed upload whose readback was corrupted, followed by one restore of the previous public bytes and a readback of those bytes. It does not prove a live alias move.
- The deployment URL pattern is `https://<id>.<name>.pages.dev` with an id of at least 8 characters. A Wrangler build whose success text does not include that URL fail-closes. This was not executed against the live Wrangler.
- Full host-tree rehearsal, including the real webhook consumer and the live rollback alias, is still an operator step after this package. This checkout did not install, arm, pause, merge, or publish on the live host.
- `publish.sh.bak-*` copies were not in the snapshot and are not updated.
- The morning path does not GET the deployment after Wrangler. Its marker is still the log gate above, not a manifest readback. That was left in place so the daily run does not gain a new success condition.
- Pages deployment `ec186425` was reported by the operator. It is not in this repository, and this checkout did not read the live host. The GitHub notify job logged HTTP 200 for a ping of `f78a925`; that log is not the Pages deployment id.
- `589f30cf` is not a commit object in this clone. `668` is not a git SHA. Both stay invalidated as release baselines. No old artifact bytes are stored here.
