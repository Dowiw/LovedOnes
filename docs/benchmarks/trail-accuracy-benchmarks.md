# Trail Accuracy & Map-Matching Benchmarks (Issue #23 / PR #29)

All measurements below are **strictly local, in-process, non-network benchmarks** (`node:perf_hooks` `performance.now()`) sanitized for public repository visibility.

---

## 1. Benchmark Environment (Sanitized Hardware Class)

| Component | Baseline Class |
|---|---|
| **CPU Class** | `x86_64` 6-Core / 12-Thread Consumer CPU (`3 MiB` L2, `16 MiB` L3) |
| **Memory** | `~10 GiB` RAM |
| **Storage / Filesystem** | Local Linux `ext4` SSD |
| **Runtime** | Node.js `v22.x`, single-thread execution |
| **Vector Archive** | Local `.pmtiles` vector archive (Protomaps MVT Zoom 14, local `FileHandle.read` byte-range reads) |

---

## 2. Spatial Accuracy Metrics

Evaluated across two synthetic multi-modal reference trajectories:
1. **Route A (`Rail → Road → Park`):** Elevated rail viaduct (`rail`) → station transfer → urban street (`minor_road`) → park footpaths (`path`). Includes a `210 m` startup spike, two crisp-reported `15 m` off-angle triangle spikes, a `110 m` cross-river bounce, and a `95 m` lateral courtyard bounce.
2. **Route B (`Walk → Transit → Destination`):** Residential walk → avenue/tramway (`major_road` / `rail`) → destination stop. Includes a `240 m` startup spike and `95 m` / `110 m` / `120 m` lateral bounces.

| Spatial Metric | Route A (`Rail → Road → Park`) | Route B (`Walk → Transit → Destination`) |
|---|---|---|
| **Raw `LocationPing`s → After Ingestion → Active Stops** | `19` → `17` → **`10` stops** (`3` dwells, `7` waypoints) | `15` → `12` → **`7` stops** (`2` dwells, `5` waypoints) |
| **Raw Polyline Length (Before)** | `3,119 m` | `2,433 m` |
| **Snapped Polyline Length (After)** | **`2,364 m`** | **`2,086 m`** |
| **Phantom Zig-Zag Detour Removed** | **`-755 m` (`-24.2%`)** | **`-347 m` (`-14.3%`)** |
| **Mean Distance from PMTiles Vector Network** | `9.34 m` → **`0.06 m` (`-99.4%`)** | `4.91 m` → **`0.56 m` (`-88.6%`)** |
| **Max Distance from PMTiles Vector Network** | `75.99 m` → **`1.93 m` (`-97.5%`)** | `17.25 m` → **`14.08 m`** (indoor courtyard dwell) |
| **Vector Network Snap Coverage (`road` vs `direct`)** | **`95.5%`** (`4.5%` is the `~105 m` vertical station exit from elevated rail to street) | **`78.6%`** (`21.4%` is the off-street courtyard entry/exit) |
| **False Moving Spurs (`spur` segments)** | **`0`** | **`0`** |

---

## 3. Computational & Memory Metrics

| Subsystem | Algorithmic Complexity / Bound | Observed Value |
|---|---|---|
| **PMTiles Vector Graph Density (Zoom 14)** | Hard-capped at `MAX_TILES_PER_TRIP = 36` | **Route A:** `4,503` features / `16,995` vertices (`639` rail vertices)<br/>**Route B:** `6,128` features |
| **Spatial Graph Construction (`buildRoadGraph`)** | $O(V)$ spatial hash-grid (`2.5 m` node merge, `80 m × 80 m` segment grid cells) | Single linear pass over `~17,000` vertices |
| **Snap Candidate Lookup (`findSnapCandidates`)** | $O(1)$ grid cell neighborhood (`150 m` radius), top `MAX_CANDIDATES_PER_STOP = 4` | `≤ 4` candidates evaluated per stop |
| **Dwell Corridor & PMTiles Triangle Bearing Pruning** | $O(N \cdot C)$ linear pass ($N$ stops, $C \le 4$ candidates) | `< 80` angle/cross-track checks per trip |
| **Viterbi DP + 1-Step Skip + A\* Routing** | $O(N \cdot C^2)$ transitions; A\* hard-capped at `MAX_ASTAR_EXPANDED_NODES = 12,000` | `≤ 32` A\* leg evaluations per stop |
| **Process Memory Footprint** | LRU tile cache (`256` tiles) + LRU trip cache (`128` trips) | **`65.7 MB` V8 Heap Used (`268.0 MB` RSS)** |

---

## 4. In-Process Speed & Latency Metrics (Non-Network)

| Pipeline Stage | Route A (`19` pings) | Route B (`15` pings) | 1,000-Ping Stress Batch |
|---|---|---|---|
| **PMTiles MVT Tile Decode (Cold disk read + Gzip + PBF parse)** | `53.59 ms` (one-time) | `53.59 ms` (one-time) | `53.59 ms` |
| **PMTiles MVT Tile Lookup (Warm LRU tile cache)** | **`0.232 ms` (`232 µs`)** | **`0.232 ms` (`232 µs`)** | **`0.232 ms`** |
| **1. Ingestion Spike & Cross-Track Filter** (`filterAnomalousLocationPoints`) | **`0.0353 ms` (`35.3 µs`)** | **`0.0191 ms` (`19.1 µs`)** | **`~1.80 ms`** |
| **2. Dwell & Stop Clustering** (`averageNearbyTrailPings`) | **`0.0770 ms` (`77.0 µs`)** | **`0.0598 ms` (`59.8 µs`)** | **`3.862 ms`** |
| **3a. Map Matching — Cold Trip** (`RoadTrailMatcher.matchTrails`, uncached) | **`266.83 ms`** | **`132.84 ms`** | Bounded by trip split (`30 min` / `2.5 km`) |
| **3b. Map Matching — Warm SHA-1 Cache Hit** (`RoadTrailMatcher.matchTrails`) | **`0.0108 ms` (`10.8 µs`)** | **`0.0101 ms` (`10.1 µs`)** | **`~0.011 ms`** (**`~24,700×` speedup**) |
| **4. GeoJSON Feature Assembly** (`buildTrailGeoJsonFeatures`) | **`0.0104 ms` (`10.4 µs`)** | **`0.0022 ms` (`2.2 µs`)** | **`~0.45 ms`** |
| **Total In-Process Read Time (Warm Cache Hit)** | **`0.1335 ms` (`133.5 µs`)** | **`0.0912 ms` (`91.2 µs`)** | **`~6.12 ms`** |

---

## 5. Measured Overhead of Follow-Up Accuracy Enhancements

| Proposed Enhancement | Complexity | Measured CPU Overhead | % of Cold Trip Match |
|---|---|---|---|
| **1. Parallel Rail Candidate Dedup & Kind Diversity** | $O(C^2)$ per stop ($C \le 12$) | **`~0.040 ms` (`40 µs`) / trip** | `+0.02%` |
| **2a. Station-to-Street Transfer Bridges (Full Bbox)** | $O(V_{\text{rail}})$ `25 m` grid lookup (`639` rail vertices) | **`4.868 ms` / trip** | `+1.82%` |
| **2b. Station-to-Street Transfer Bridges (Stop-Local Only)** | $O(N_{\text{stops}})$ `35 m` grid lookup ($N \le 25$) | **`~0.150 ms` (`150 µs`) / trip** | **`+0.06%`** |
| **3. Inverse-Variance (`1 / accuracy²`) Stop Centroids** | $O(1)$ per ping (`3` mults, `1` div) | **`0.0342 ms` (`34.2 µs`) per 1,000 pings** (`34 ns`/ping) | `+0.01%` |
| **4. In-Memory Single-Ping Ingestion Bounce Guard** | $O(1)$ per batch (`2` haversines) | **`< 0.005 ms` (`< 5 µs`) / write** | `0%` on read |
| **5. Turn-Triggered Mobile Sampling (`\|Δheading\| ≥ 35°`)** | $O(1)$ inside mobile GPS callback | **`< 0.001 ms` (`< 1 µs`) on device** | N/A (client-side) |
