# Frozen artifact publication

The live entry is `bash /workspace/digest/check_sections.sh`. It compares `git ls-remote` with the first line of `.sections_deployed` and, on a change, runs `publish.sh` with `BUTTONDOWN_SKIP=1`. There is no separate marker program. `publish.sh` is the only writer of `.sections_deployed`.

This package is not installed. Do not run it against `/workspace/digest` from this checkout. `install.sh` and `rollback.sh` refuse that path unless `ADRRR_INSTALL_CONFIRM=1`. `arm` writes only the pin and the hold; it does not deploy.

Deleting `.publish_window_pin` is not how this window goes live. While the pin is armed or committed, `check_sections.sh` uploads the pinned artifact tree or fails closed. It does not reassemble, refresh images, or send mail. The morning assembler returns only after `release-daily`, and only for a direct `publish.sh`. A webhook replay stays on the frozen transaction until that morning run clears the pin.

## Snapshot the patches are based on

Sanitized bytes match the original manifest. No literal secrets, and no config, token, or userdata files were in the snapshot.

| file | snapshot sha256 | mtime (HKT) |
| --- | --- | --- |
| `publish.sh` | `fbc85d30fb90c14ab262d0aa40918617b45df6547616639cfc138e6fe51da6bb` | 2026-11-25 11:51:20 |
| `check_sections.sh` | `293523484f92c3f0267c21b174f0c9efb27383ff91475bce5e486e8c4ddb4820` | 2026-11-25 11:50:49 |
| `tools/latest_json.py` | `aba56c7d5d54587173492d970fe9c7486f421ef438df35d6f71789e8d0d6a338` | 2026-11-25 11:50:44 |
| `tools/og_images.py` | `1758cf46369e84294938f25ea6c4574806525cfff5dd62da30a5dd0e9baac510` | 2026-11-25 11:51:25 |

`validate_wrap_urls.py` is not modified. `build_site.py` was not in the snapshot and the window path does not import it.

Marker observed in the snapshot, not copied and not written by it: `/workspace/digest/.sections_deployed` = `e8bd0b27ba23cb9dd5e8eba6c4e0847a7c823b05`, mtime **2026-11-25 11:51:52 HKT**. The SHA matches the earlier morning value. The mtime does not. Do not treat that marker as an unchanged 08:48 baseline, and do not treat it as proof that Functions uploaded. This patch does not clear it.

## Patched hashes

| file | patched sha256 |
| --- | --- |
| `patched/publish.sh` | `94fb245a31283fdd43ab8d6f29d347c2e1ec087e33d6840c94c8e18422ef537c` |
| `patched/check_sections.sh` | `274c03ba9f541a9e00f5ffc37dbcb3ef5e8608ef20f893d8df549b0594557c19` |
| `patched/tools/latest_json.py` | `59c3b90c8905a0461ec7adf37993f1b0136dd2bd3d495f69a67f68606f91a848` |
| `patched/tools/og_images.py` | `236f0bc028d2adce9776076fc3e8bbde28628402d665ba73e4b188eddc976adb` |
| `publish_window.py` | `9ff6e677a484af2e8a3fa858d3672a05b6542031fb7e11c03bbc83009090a587` |

## Bootstrap, before any merge

1. Under the publish lock, `install.sh` checks each live file against the snapshot hash. Any other hash stops the install and writes nothing. A hash that already matches the patched file is left in place.
2. Previous bytes are copied to `.publish_window_backup/<stamp>/`, then each file is renamed into place. Installed files: `publish.sh`, `check_sections.sh`, `tools/latest_json.py`, `tools/og_images.py`, `tools/publish_window.py`.
3. Re-hash. They must equal the patched table. `rollback.sh` restores that stamp only when the live bytes are still the patched bytes or already the backup, and only when `.publish_window_pin` and `.publish_window_hold` are both absent. Abort or finish the window first. A later edit stops the rollback.
4. Leave `ADRRR_PUBLISH_MODE` and `ADRRR_FROZEN_ROOT` unset. Unset mode, with no pin, still uses `/workspace/digest`, still rewrites the data JSON, still upgrades a soft hero, and still sends the morning mail. `check_sections.sh` still forces `BUTTONDOWN_SKIP=1` and strips those two variables on every invocation.
5. Do not merge while step 3 has not passed. A repo commit does not change the scripts the host executes.

## Arm the artifact tree

`build_site.py` is not in the snapshot. Do not run it for this publication. The approved input is a directory outside `/workspace/digest` that already contains the exact tree Wrangler should upload, including `functions/` byte-for-byte equal to `sections-src/functions`, plus the public pages (`index.html`, `news/...`, `favicon.ico`). `_redirects` and `_headers` belong in that tree too. Symlinks are refused.

`sections-src` must already be checked out at the commit remote `main` will be. Arm records that HEAD. It does not fetch or reset. A later merge commit with a different SHA fail-closes. Fast-forward `main` to this SHA, or arm again after that exact commit is checked out and the artifact tree still matches it.

```bash
python3 /workspace/digest/tools/publish_window.py arm \
  --host /workspace/digest \
  --artifacts "$APPROVED_TREE" \
  --until 2026-11-26T08:00:00+08:00
```

This writes `.publish_window_pin` and `.publish_window_hold`. Both must stay. The pin stores the sections SHA, the script and functions hashes, every artifact hash, and the public subset used for readback. `until` is a deadline. When it passes, the entry fail-closes. It does not fall through to the morning assembler.

## What an invocation does

Use the real entry. Pending and replayed calls are the same command:

```bash
bash /workspace/digest/check_sections.sh
```

The direct equivalent, still outside the morning path, is `publish.sh` with no `ADRRR_WINDOW_ENTRY`. While the pin is armed, both upload the pinned tree.

`check_sections.sh` during the window:

- `ls-remote` failure exits 3. It does not warn-and-exit 0. Without a pin or hold, that failure still prints `WARN: ls-remote failed` and exits 0, which is the previous daily behavior.
- Remote SHA other than the pinned SHA exits 3. The checkout is not fetched or reset.
- Script, functions, or artifact drift exits 3.
- Otherwise it runs `publish.sh` with `BUTTONDOWN_SKIP=1` and `ADRRR_WINDOW_ENTRY=1`. A leaked `ADRRR_PUBLISH_MODE=frozen` is stripped and does not select a build-only path.

`publish.sh` on the window route, under the existing publish lock:

1. Re-checks the pin, the hold, the scripts, the artifact bytes, the local HEAD, and `ls-remote`. No `build_site.py`, no `latest_json.py`, no image refresh, no generator, no git fetch, no `deploy/` swap, no data or cache write.
2. Copies the pinned files into a temp stage and runs the same Wrangler command as the morning path.
3. Requires Wrangler exit 0, the text `Deployment complete`, a deployment-specific `https://<id>.<project>.pages.dev` URL, and `Uploading Functions bundle` when `functions/` is in the stage. The complete-line alone does not commit.
4. GETs every public artifact path from that deployment URL and compares SHA-256. `ADRRR_READBACK_ORIGIN` is a test transport only. Leave it unset on the host.
5. Only then writes `.sections_deployed`:

```
<sections sha>
identity <script_identity> <artifact_identity> <deployment_id>
url https://<id>.<project>.pages.dev
```

The window path does not send mail, even if `BUTTONDOWN_SKIP` is unset. The webhook still passes `BUTTONDOWN_SKIP=1`, so a bug that reached the morning mail block would still skip.

A second invocation whose scripts, artifact bytes, and public bytes still match is a no-op: no upload, no mail, no data rewrite. The no-op key is the sections SHA plus the script identity plus the artifact identity plus the read-back bytes. The SHA alone is not enough. If the public bytes differ and the artifact tree is still intact, the entry uploads that same tree again and replaces the marker only after the new deployment reads back. A readback transport failure exits non-zero and does not upload.

## Return to the morning run

After the marker identity is in place and a replay reads back clean:

```bash
python3 /workspace/digest/tools/publish_window.py release-daily --host /workspace/digest
```

This does not publish. The next direct `./publish.sh <dated-folder>` is the morning path again: assemble, data JSON rewrite, soft-hero upgrade, mail on the existing weekday rules. `check_sections.sh` between release and that morning run still no-ops or re-uploads the pinned artifacts. It does not assemble. When the morning deploy is verified, `publish.sh` rewrites the marker as the SHA only and deletes the pin and the hold. Later webhook calls with the same SHA take the old unchanged exit and do not refresh.

`abort` deletes the pin and the hold only before a deployment identity is on the marker. That is the supported way to leave an armed window without publishing. After a commit, abort is refused. If both files are removed and the identity marker remains, `check_sections.sh` exits 3. Restore them with `resume --host ... --artifacts <the same tree> --until <future>` and then release, or leave the entry fail-closed. Do not hand-delete the pin in order to refresh.

## Daily behavior that stays

With no pin, no hold, and a SHA-only marker:

- `check_sections.sh` still exits 0 on `ls-remote` failure, on an empty repo URL, on a missing report folder, and when the remote SHA equals the marker.
- A changed SHA still runs `publish.sh` with `NETLIFY_MIRROR=0` and `BUTTONDOWN_SKIP=1`.
- The morning marker is written only when Wrangler exits 0, the log contains `Deployment complete`, and a present `functions/` directory also produced `Uploading Functions bundle`. Otherwise the script exits 1 and does not write the marker or send mail.
- `latest_json.py` failure still warns and the news tree still deploys.
- `home-preview`, `seo-meta`, `news-feed`, and `build-sitemap` still warn and continue.
- IndexNow and Buttondown failures after a verified morning marker still warn.
- The opt-in Netlify mirror still ends in `|| true` and stays off unless `NETLIFY_MIRROR=1`.
- The wrap-URL gate and the sections SHA mismatch still exit before assemble.
- `ADRRR_PUBLISH_MODE=frozen` on a direct morning `publish.sh`, with no armed window, exits 3. It does not build a side tree and it does not refresh.

## Not proven

- The platform may or may not retry a non-zero `check_sections.sh`. The 30-minute cadence is the script's usage comment, not a captured cron. The installed scripts do not need that retry: the next local invocation sees the pin.
- `build_site.py` is still required by the morning assembler and was not in the snapshot. The window path does not execute it. If the approved artifact directory is missing or was never assembled, arm or the window route fails closed. This package cannot build that tree.
- HTTP readback proves the pinned public file bytes on the deployment-specific URL. It does not list unexpected extra files. `functions/`, `_redirects`, and `_headers` are pinned and staged, but Pages does not serve them as ordinary URLs, so they are not part of the GET. Functions still require the Wrangler bundle line. That line is not a byte-for-byte readback of the worker.
- Wrangler can make a deployment the production alias before readback runs. A failed readback does not roll that alias back. The marker stays unwritten, and a later invocation uploads the pinned bytes again.
- The deployment URL pattern is `https://<id>.<name>.pages.dev` with an id of at least 8 characters. A Wrangler build whose success text does not include that URL fail-closes the window. This was not executed against the live Wrangler.
- Readback on every committed replay GETs each public file. A transport error fail-closes without uploading. A hash mismatch uploads the pinned tree again.
- Remote `main` must already be the pinned SHA. This path will not fast-forward the checkout to a GitHub merge commit.
- Hand-deleting both pin and hold before any marker identity is an abort, and the next pin-less invocation is the daily path. After a commit, the identity marker blocks that fall-through until `resume`.
- Rolling the scripts back by hand, while an identity marker is still installed, returns the baseline comparator. Baseline `check_sections.sh` reads the whole marker file, so it will not treat that file as the SHA and can assemble. Use `rollback.sh`, which refuses to run while the pin or hold exists.
- `publish.sh.bak-*` copies were not in the snapshot and are not updated.
- The morning path does not GET the deployment after Wrangler. Its marker is still the log gate above, not a manifest readback. That was left in place so the daily run does not gain a new success condition.
- The existing marker was not re-checked for a Functions bundle. Its mtime moved at 11:51:52 while the SHA stayed `e8bd0b27`.
- No live host file was installed, and nothing was merged or deployed.
