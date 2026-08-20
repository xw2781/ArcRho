---
name: smb-stat-metadata-alternation
description: "os.stat on the E: mapped drive from a Client PC alternates between fresh and cached metadata for ~9s after a server-side write, so any stat-only fingerprint baseline taken right after a hosted save can miss that save - measured 2026-08-20 with the Engine heartbeat"
metadata:
  type: project
---

Measured 2026-08-20 on Client PC `L-H2MQ6280FVP` against `E:\ArcRho Server` (mapped to the
Dev PC). Repeated `os.stat` of one file that the **server** rewrites does not merely lag —
it **alternates** between the current and a cached older copy, for many seconds:

```
observed 11:19:26.028 -> mtime 11:19:26.153   fresh
observed 11:19:26.242 -> mtime 11:19:21.011   stale, goes backwards
observed 11:19:27.572 -> mtime 11:19:21.011   6.6s stale
observed 11:19:30.149 -> mtime 11:19:21.011   9.1s stale
observed 11:19:33.831 -> mtime 11:19:26.153   7.7s stale
```

**Why:** same redirector caching as [[propagation-status-smb-cache-lag]] (this machine's
`LanmanWorkstation\Parameters` lifetimes are unset = Windows defaults, FileInfoCacheLifetime
10 s), but it also affects **metadata**, not just content reads, and a single process sees
both copies interleaved. A client-side write does not invalidate it because the writer is
the Engine on the server.

**How to apply:** never treat one `os.stat` of a share path as authoritative about a write
that just happened on the server. Anything that baselines a stat and compares it later
(`object_change_watch_service`'s fingerprint is the live example — a post-save rebase can
capture the pre-save stat and then alert on the user's own save ~10-15 s later) needs either
`app_server.helpers._bust_network_lookup_cache(directory)` before the read, or confirmation
against content the payload records (`updated_at`, audit entry, revision) rather than stat
alone.

**Repro technique** (no second machine needed): the Engine rewrites
`runtime/instances/arcrho_engine/<id>.json` every few seconds from the server. Stat it from
the client every 50 ms and print each distinct `(st_mtime_ns, st_size)` with the client clock
at first sighting; the backwards jumps are the cache. Negative "age" values give you the
clock skew (~0.2 s here), so don't read small lags as caching.

Related: [[pi-path-load-smb-cost]], [[dfm-save-propagation-profile]].
