# YouTube Skill Robustness Plan

Research date: 2026-09-16.

## Objective

Make `/youtube` a single self-diagnosing YouTube runtime for discovery, metadata, transcripts, captions, and media acquisition.

The realistic reliability target is **no unclassified failure and no repeated blind retries**. YouTube can change server-side behavior without notice, so “never fail” cannot literally be guaranteed. Every known failure class should instead have one of:

1. an automatic fallback;
2. a cooldown/circuit breaker;
3. a precise terminal state with a reset/recovery condition.

The agent should never have to rediscover the PO-token command, manually find a scratch provider, or infer that a quota/IP block happened from generic stderr.

---

## What is broken today

### 1. Search quota is unmanaged

`data.py search` calls the official `search.list` endpoint directly. There is no persistent call ledger, cache, reserve, or preflight budget.

Google changed YouTube Data API quotas in June 2026. `search.list` now has its own default bucket of **100 calls/day**, with each page request consuming another call. Other API reads generally share a separate 10,000-unit daily bucket. Daily quota resets at midnight Pacific Time.

Observed consequence: the research sweep exhausted the Search API quota and later searches failed even though normal video/channel metadata calls could still work.

Sources:

- https://developers.google.com/youtube/v3/getting-started
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/docs/search/list

### 2. Public transcript flow spends an expensive/weak API call first

`transcript.py` currently calls `captions.list` before the public-player fallback.

Problems:

- `captions.list` costs **50 units** per call.
- it requires OAuth authorization;
- it lists caption tracks but does not return caption text;
- API/player caption metadata can disagree. During the case-study research, multiple videos reported `caption=false` through API metadata while direct YouTube player extraction exposed original automatic-caption tracks.

For public-video transcript research, this should not be the primary path.

Source: https://developers.google.com/youtube/v3/docs/captions/list

### 3. `youtube-transcript-api` can trigger IP blocks

The current public-player fallback uses `youtube-transcript-api`. Its own documentation warns that YouTube can return `RequestBlocked` / `IpBlocked`, including on self-hosted IPs after too many requests. We observed the equivalent bulk-transcript failure/rate blocking during research.

Source: https://github.com/jdepoix/youtube-transcript-api/blob/master/README.md

### 4. Media downloads now need a maintained player runtime

YouTube increasingly requires Proof-of-Origin tokens. yt-dlp documents that missing PO tokens can cause HTTP 403 or IP/account blocking. The current recommended setup is a PO-token provider with the `mweb` client for GVS requests.

yt-dlp also now depends on external JavaScript challenge solving (EJS). Node >=22 is supported when explicitly enabled; Deno >=2.3 is the recommended default runtime.

Current machine state:

- `yt-dlp 2026.07.04`: installed;
- Node `v24.14.0`: compatible;
- Deno: not installed;
- `ffmpeg 9.0.1`: installed;
- Whisper CLI: installed;
- `yt-dlp-ejs`: **not installed** in the current Python environment;
- `bgutil-ytdlp-pot-provider`: **not installed** in the current Python environment;
- a BgUtils 2.0.0 HTTP provider is running successfully on `127.0.0.1:4416`, but its code lives under `.local-system/scratch/2026-09-15/...`.

That scratch dependency is the biggest operational fragility.

Sources:

- https://github.com/yt-dlp/yt-dlp/wiki/Po-Token-Guide
- https://github.com/yt-dlp/yt-dlp/wiki/EJS
- https://github.com/Brainicism/bgutil-ytdlp-pot-provider

### 5. Some errors are currently swallowed

The search enrichment path catches a broad exception around `videos.list` and silently continues. This can make quota/auth/player failures look like “stats unavailable” instead of exposing the actual failure state.

### 6. There is no one health/status command

The agent currently learns that search quota, transcript access, JS challenge solving, the PO provider, or ffmpeg is broken only after starting real work.

---

# Target architecture

## A. One shared runtime module

Create `scripts/runtime.py` used by every YouTube command.

It owns:

- executable discovery (`yt-dlp`, Node/Deno, ffmpeg, Whisper);
- yt-dlp standard arguments;
- PO-token provider health/startup;
- error classification;
- cache/state locations;
- retry/cooldown policy.

No research script should contain its own hand-written yt-dlp incantation again.

### Standard yt-dlp profile

On this machine, use Node because a supported Node version already exists:

```text
--js-runtimes node:/usr/local/bin/node
--extractor-args youtube:player_client=mweb
```

Install the matching EJS package alongside yt-dlp instead of depending on one-off flags. Keep yt-dlp and `yt-dlp-ejs` compatibility checked by `doctor`.

## B. Skill-owned PO provider

BgUtils 2.0.0 is currently the latest release and is explicitly recommended by yt-dlp's PO-token documentation. Version 2.0.0 also fixes the earlier unsafe default network binding; the server now binds to localhost by default.

Move provider ownership out of Local System scratch.

Proposed persistent runtime location:

```text
~/.local/share/youtube-skill/bgutil/2.0.0/
~/.local/state/youtube-skill/
~/.cache/youtube-skill/
```

`runtime.ensure_po_provider()` should:

1. call `http://127.0.0.1:4416/ping`;
2. validate provider version;
3. if absent, start the skill-owned provider bound to loopback;
4. wait for a bounded health-check window;
5. record PID/log path;
6. return structured health rather than leaking process-management details to callers.

For bulk research, keep the HTTP provider as primary because the provider project recommends it over spawning the generation script repeatedly. Script-provider mode can remain a fallback.

## C. Quota manager

Add `scripts/quota.py` with persistent state in `~/.local/state/youtube-skill/quota.json`.

Track at least:

- `search.list` calls for the current Pacific-Time quota day;
- ordinary API estimated units;
- expensive `captions.list` calls;
- last observed `quotaExceeded` / search-quota error;
- reset timestamp.

### Rules

1. **Search is the scarce resource.** Reserve part of the 100-call bucket instead of running to zero.
2. Normalize and cache search query + parameters. Repeated identical searches return cached results unless `--refresh` is explicit.
3. Estimate the number of pages before a multi-query sweep and reject/trim a sweep that would exceed the remaining budget.
4. When quota is exhausted, trip a circuit breaker until midnight PT. Do not keep probing the same API.
5. Channel-history enumeration must not use search.

### Cheap channel-history path

Once a channel is known:

```text
channels.list (1 unit)
    -> contentDetails.relatedPlaylists.uploads
playlistItems.list (1 unit/page, up to 50 videos/page)
videos.list / videos.batchGetStats for metadata/stats
```

This preserves `search.list` exclusively for actual discovery.

Google documents `playlistItems.list` and `channels.list` as 1-unit reads. In June 2026 Google also added `videos.batchGetStats` with its own high-volume quota bucket; use it where the installed client/discovery document supports the method.

Sources:

- https://developers.google.com/youtube/v3/docs/channels/list
- https://developers.google.com/youtube/v3/docs/playlistItems/list
- https://developers.google.com/youtube/v3/revision_history

## D. Transcript state machine

Replace the current “official captions call + one fallback” flow with an explicit pipeline.

### Order

```text
1. transcript cache
2. direct yt-dlp subtitle/auto-caption extraction through maintained player runtime
3. youtube-transcript-api lightweight fallback
4. audio download through maintained player runtime -> local Whisper
5. terminal no-transcript state
```

Important rules:

- Never use `videos.contentDetails.caption == false` as a reason to skip extraction.
- Do not call `captions.list` for ordinary public transcript retrieval.
- Keep `captions.list` only for an explicit owned/channel-management operation where its 50-unit cost and OAuth semantics are justified.
- Prefer original-language tracks (`hi-orig`, `en-orig`) before translated tracks.
- Store the raw JSON3/VTT plus a normalized timestamped transcript.
- Label acquisition source: `youtube_auto_caption`, `youtube_manual_caption`, `transcript_api`, or `local_whisper`.

### 429 / IP-block behavior

Classify `RequestBlocked`, `IpBlocked`, HTTP 429, and equivalent YouTube block responses as one cooldown family.

When detected:

1. stop that retrieval backend immediately;
2. record a cooldown timestamp;
3. switch to the next independent backend;
4. do not blindly retry it for every video in a batch.

Residential proxies can be supported as an **optional** configured backend because `youtube-transcript-api` documents them, but they should not be a mandatory dependency for local use.

## E. Media acquisition state machine

Add a proper media command instead of relying on project-specific shell scripts.

Suggested interface:

```bash
python3 scripts/media.py download <video> --purpose visual-sample --max-height 360
python3 scripts/media.py download <video> --purpose audio-transcript
python3 scripts/media.py download <video> --purpose full
```

All variants use `runtime.py` and the same provider/JS configuration.

Fallbacks should be selected by error class rather than repeated arbitrary yt-dlp flags.

## F. Error taxonomy

Every backend error maps to a machine-readable reason:

| Error class | Retry now? | Automatic action |
|---|---|---|
| `SEARCH_QUOTA_EXHAUSTED` | No | use cache/degraded discovery; wait until PT reset |
| `API_DAILY_QUOTA_EXHAUSTED` | No | avoid affected API bucket until reset |
| `HTTP_429_OR_IP_BLOCKED` | No | trip backend cooldown; use next transcript/media backend |
| `PO_PROVIDER_DOWN` | After repair | auto-start/health-check provider |
| `PO_TOKEN_REJECTED` | Once after provider refresh | refresh provider/token, then alternate player strategy |
| `JS_RUNTIME_MISSING` | No | doctor reports exact dependency/action |
| `EJS_MISSING_OR_MISMATCHED` | No | doctor reports compatible install/update action |
| `CAPTIONS_DISABLED` | No caption retry | audio -> Whisper if media is playable |
| `NO_REQUESTED_LANGUAGE` | Yes via alternate | select original/available track or Whisper |
| `AGE_OR_AUTH_REQUIRED` | Not anonymously | use authorized/cookie route only if configured |
| `REGION_BLOCKED` | No blind retry | structured terminal state / configured proxy only |
| `VIDEO_UNAVAILABLE` | No | terminal |

No `except Exception: pass` around network operations.

---

# Doctor command

Add:

```bash
python3 scripts/doctor.py
python3 scripts/doctor.py --json
python3 scripts/doctor.py --online
```

Default doctor is cheap and non-destructive. It checks:

1. API credentials and registered channels;
2. local search-quota ledger + reset time;
3. yt-dlp version;
4. Node/Deno compatibility;
5. EJS package compatibility;
6. BgUtils plugin/provider version and `/ping` health;
7. ffmpeg;
8. transcript Python dependency;
9. Whisper availability/model cache;
10. cache/state writability.

`--online` additionally runs one bounded public smoke check against a known stable test video.

The skill instruction should say: **run doctor once before large YouTube research batches and automatically after any unclassified YouTube failure.**

---

# Caching and batch behavior

Use `~/.cache/youtube-skill/` for:

- search responses keyed by normalized query/params;
- video/channel metadata;
- caption tracks and normalized transcripts;
- yt-dlp info JSON;
- provider capability results.

Suggested TTLs:

- search: 6–24 hours;
- video statistics: 15–60 minutes for active research;
- channel metadata: 1 hour;
- transcripts: long-lived, with explicit refresh;
- immutable raw caption/media acquisition manifests: no automatic expiry.

Batch commands must deduplicate video IDs before touching any backend.

---

# Tests required before calling the rebuild robust

## Unit fixtures

Test classification/fallback for:

- 403 missing PO token;
- PO provider unavailable;
- 429 / `RequestBlocked` / `IpBlocked`;
- search quota exhausted;
- API metadata says `caption=false` while player track exists;
- captions disabled;
- no requested language;
- EJS/runtime missing;
- provider version mismatch;
- Pacific-Time quota reset.

## Integration tests

1. `doctor --json` returns every subsystem state.
2. repeated identical search uses one quota call then cache.
3. known channel history uses uploads playlist, never `search.list`.
4. transcript extraction succeeds from an auto-caption video.
5. a caption-metadata false negative still attempts direct extraction.
6. media sample downloads with PO provider and JS solver enabled.
7. simulated provider death is self-repaired.
8. simulated 429 trips cooldown and skips repeated failing calls.

## Long smoke / chaos test

Run a mixed list of videos that includes:

- English auto captions;
- Hindi auto captions;
- no captions;
- video requiring PO token;
- unavailable/private video;
- 20+ channel-history pages/search operations under a synthetic quota budget.

The pass condition is not “every video succeeds.” The pass condition is **every video finishes in the correct state without manual command invention or uncontrolled retries**.

---

# Implementation sequence — one rebuild, not piecemeal patches

## Phase 1 — Core runtime

Create `runtime.py`, `quota.py`, error classes, state/cache layout, provider supervisor, and `doctor.py`.

## Phase 2 — Data API efficiency

Refactor search through quota/cache manager; add public channel upload-history enumeration; use cheap batched metadata/stat calls; remove silent exception swallowing.

## Phase 3 — Transcript/media unification

Replace transcript pipeline, add media acquisition command, centralize yt-dlp args, install/manage EJS + BgUtils dependencies, add Whisper fallback.

## Phase 4 — Tests and documentation

Add deterministic fixtures, live smoke tests, failure/cooldown tests, and update `/youtube` skill instructions so agents use the new runtime rather than hand-building fallbacks.

## Phase 5 — Migration/cleanup

Validate the skill-owned provider, then retire dependence on the provider currently running from `.local-system/scratch`. Do not remove the working scratch provider until the new runtime passes the media and transcript smoke tests.

---

# Acceptance criteria

The YouTube rebuild is complete only when all of the following are true:

1. A fresh agent can run one documented doctor command and know whether search, metadata, transcripts, and media are healthy.
2. Bulk discovery cannot unknowingly consume the final Search API calls.
3. Channel-history research does not spend Search API quota.
4. `caption=false` cannot incorrectly terminate transcript discovery.
5. A transcript IP block cannot cause a batch to hammer the same blocked backend.
6. Media download never depends on a path in Local System scratch.
7. PO provider and JS challenge requirements are installed/checked centrally.
8. No YouTube network error is silently swallowed.
9. Every returned transcript/media artifact records how it was acquired.
10. The automated failure matrix and live smoke suite pass before the old workaround paths are removed.
