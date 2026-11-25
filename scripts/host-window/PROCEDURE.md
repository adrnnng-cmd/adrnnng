# Frozen window install

The live entry is `bash /workspace/digest/check_sections.sh`. It compares `git ls-remote` with `.sections_deployed` and, on a change, runs `publish.sh` with `BUTTONDOWN_SKIP=1`. There is no separate marker program. `publish.sh` writes `.sections_deployed` only after a verified upload.

This package is not installed. Do not run it against `/workspace/digest` from this checkout. `install.sh` refuses that path unless `ADRRR_INSTALL_CONFIRM=1`.

## Snapshot the patches are based on

Sanitized bytes match the original manifest. No literal secrets, and no config, token, or userdata files were in the snapshot.

| file | snapshot sha256 | mtime (HKT) |
| --- | --- | --- |
| `publish.sh` | `fbc85d30fb90c14ab262d0aa40918617b45df6547616639cfc138e6fe51da6bb` | 2026-11-25 11:51:20 |
| `check_sections.sh` | `293523484f92c3f0267c21b174f0c9efb27383ff91475bce5e486e8c4ddb4820` | 2026-11-25 11:50:49 |
| `tools/latest_json.py` | `aba56c7d5d54587173492d970fe9c7486f421ef438df35d6f71789e8d0d6a338` | 2026-11-25 11:50:44 |
| `tools/og_images.py` | `1758cf46369e84294938f25ea6c4574806525cfff5dd62da30a5dd0e9baac510` | 2026-11-25 11:51:25 |

`latest_json.py` and `og_images.py` are the same bytes as the earlier attachment. The earlier one-line caller hunk is not applied. `ADRRR_DIGEST_DIR` stays the data directory `publish.sh` already passes to `home-preview.mjs`. Frozen mode uses `ADRRR_FROZEN_ROOT`.

Marker observed in the snapshot, not copied and not written by it: `/workspace/digest/.sections_deployed` = `e8bd0b27ba23cb9dd5e8eba6c4e0847a7c823b05`, mtime **2026-11-25 11:51:52 HKT**. The SHA matches the earlier morning value. The mtime does not. Do not treat that marker as an unchanged 08:48 baseline, and do not treat it as proof that Functions uploaded. This patch does not clear it.

## Patched hashes

| file | patched sha256 |
| --- | --- |
| `patched/publish.sh` | `366aa5d3d4595ac8da31ead97e96ad56818fcab47f3d8f027a8d0b6205f6d7e4` |
| `patched/check_sections.sh` | `e192fe93563d82c838bbb84120bf6383e34354e0af03e2b14bf9f09b5adb55a2` |
| `patched/tools/latest_json.py` | `59c3b90c8905a0461ec7adf37993f1b0136dd2bd3d495f69a67f68606f91a848` |
| `patched/tools/og_images.py` | `236f0bc028d2adce9776076fc3e8bbde28628402d665ba73e4b188eddc976adb` |
| `publish_window.py` | `568c6825689ada80fa7f18c45b82e17205caa1876be0e6b5611230781ea6408f` |

`validate_wrap_urls.py` is not modified. The call gains `--root "$SRC_ROOT"`, which is `/workspace/digest` when the mode is unset.

## Bootstrap, before any merge

1. Under the publish lock, `install.sh` checks each live file against the snapshot hash. Any other hash stops the install and writes nothing. A hash that already matches the patched file is left in place.
2. Previous bytes are copied to `.publish_window_backup/<stamp>/`, then each file is `rename`d into place. Installed files: `publish.sh`, `check_sections.sh`, `tools/latest_json.py`, `tools/og_images.py`, `tools/publish_window.py`.
3. Re-hash. They must equal the patched table. `rollback.sh` restores that stamp only when the live bytes are still the patched bytes or already the backup. A later edit stops the rollback.
4. Leave `ADRRR_HOST_ROOT`, `ADRRR_PUBLISH_MODE`, and `ADRRR_FROZEN_ROOT` unset on the host. Unset mode still uses `/workspace/digest`, still refreshes a soft hero, still rewrites the data JSON, and still sends the morning mail.
5. Do not merge while step 3 has not passed. A repo commit does not change the scripts the host executes.

## Window

1. Copy `data/`, `cache/img/`, `site/`, and `netlify_config.json` to a directory outside `/workspace/digest`. The live config file was not in the snapshot. The copy has to be made on the host.
2. `python3 tools/publish_window.py write --host /workspace/digest --until <timezone ISO> --out /workspace/digest/.publish_window_pin`
   The pin stores the sections HEAD, the marker text, script and `sections-src/functions` hashes, `data/` + `cache/img/` + `site/` hashes, and `deploy/news/latest.json`.
3. Every later `publish.sh`, including one started by `check_sections.sh`, re-reads that pin before it fetches or deletes a build tree. Drift or an expired pin exits 3. No assemble, no upload, no marker, no mail.
4. Frozen rehearsal, direct only:

```bash
ADRRR_PUBLISH_MODE=frozen ADRRR_FROZEN_ROOT="$ISOLATED" \
  bash /workspace/digest/publish.sh "$ISOLATED/site/<DATE>"
```

`check_sections.sh` strips `ADRRR_PUBLISH_MODE` and `ADRRR_FROZEN_ROOT` before it calls `publish.sh`, so a webhook cannot be turned into a non-deploy. Frozen mode does not fetch or reset, does not swap `deploy/`, does not call wrangler, IndexNow, or Buttondown, and `latest_json.py` does not fetch or rewrite the data JSON. Output is `$ISOLATED/out` only. A frozen post-step failure exits 1. The morning path still warns and continues for those same post-steps.
5. Run the same command again. `publish_window.py diff <first-out> <second-out>` lists content, mtime, and XML `<lastmod>` separately. Content or lastmod drift stops the window. mtime-only changes are listed and are not a content change. The data JSON mtime stays put.
6. Restore by deleting `.publish_window_pin`. Keep the patched scripts. The next invocation then uses the normal path: refresh and morning mail behave as before, except a deploy is marked only when wrangler exits 0, the output contains `Deployment complete`, and a present `functions/` directory also produced `Uploading Functions bundle`. Otherwise the script exits 1 and does not write the marker, send mail, or ping IndexNow.

## Replay

`check_sections.sh` exits 0 without calling `publish.sh` only when the remote SHA equals the marker. That no-op is valid after this patch only because the marker is written for a verified upload of that SHA. A failed upload leaves the marker unchanged, so the next invocation runs `publish.sh` again. A different remote SHA does not reuse the marker.

`check_sections.sh` still exits 0 when `ls-remote` itself fails. The script comment says it is invoked every 30 minutes. This package cannot see the platform queue, and it does not need the consumer source: the next local invocation of `check_sections.sh` is what runs the installed scripts. A failed `ls-remote` is not a successful deploy ack, and it is not a dropped SHA if something calls the script again.

## What stays fail-open on the morning path

- `latest_json.py` failure still warns and the news tree still deploys. Frozen mode does not.
- `home-preview`, `seo-meta`, `news-feed`, and `build-sitemap` still warn. Frozen mode exits 1.
- IndexNow and Buttondown failures after a verified marker still warn. Buttondown still runs only on the morning conditions, and the webhook still sets `BUTTONDOWN_SKIP=1`.
- The opt-in Netlify mirror still ends in `|| true` and stays off unless `NETLIFY_MIRROR=1`.
- The wrap-URL gate and the sections SHA mismatch still exit before assemble.

## Not proven

- The platform may or may not retry a non-zero `check_sections.sh`. The 30-minute cadence is the script's usage comment, not a captured cron.
- `build_site.py` is imported by `publish.sh` and was not in the snapshot.
- `publish.sh.bak-*` copies were not in the snapshot and are not updated.
- A go-live after the pin is removed still runs the normal hero refresh. Frozen mode does not upload, so the rehearsed tree is not what wrangler sends.
- The existing marker was not re-checked for a Functions bundle. Its mtime moved at 11:51:52 while the SHA stayed `e8bd0b27`.
