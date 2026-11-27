# Trail Segmentation, Multi-Day Sampling, and Timelapse Playback

Status: accepted

## Context

Issue #40 introduces multi-day trail filtering (`24h`, `3d`, `7d`, `30d`, custom dates), a sortable Trip list, and synchronized 60 FPS Timelapse playback across Web and Mobile while preserving `EXACT`, `FUZZED`, and `GHOST` privacy guarantees.

Several existing behaviors made naive implementation unsafe or confusing:
1. `splitVisitsIntoTrips` previously split only on telemetry gaps (`> 30m` or `> 15km`) and privacy changes, keeping an entire day's errands merged into a single trip.
2. `db.getGroupTrails` ran `ORDER BY recorded_at ASC LIMIT 1000`, which silently truncated multi-day queries after the oldest 1,000 pings.
3. Road-matched `TrailPathSegment`s merged road legs without timestamps, and `FUZZED` stretches snapped to coarse ~1 km grid coordinates.

## Decision

1. **Dwell-delimited Trips vs. continuous Timelapse:** `splitVisitsIntoTrips` splits `Trip`s on stationary dwells `>= 5 minutes` in addition to telemetry gaps (`> 30m`, `> 15km`) and `EXACT` ↔ `FUZZED` transitions, reusing the dwell `Stop` as the destination of the arriving `Trip` and the origin of the next. Full-window **Timelapse** still connects all `Trip`s chronologically unless the user selects a specific `Trip` to focus on.
2. **Non-destructive uniform sampling + Douglas-Peucker reduction:** Raw `location_history` rows remain intact in PostgreSQL (preserving street-level zoom-in, `FUZZED` 10-minute bucket security, and activity re-evaluation). When `[from, to]` exceeds the query row cap (`limit`, up to `10,000`), PostgreSQL samples uniformly across the full `[from, to]` window instead of truncating at day 1, and query/matcher helpers apply zoom-tolerance Douglas-Peucker simplification while returning `{ truncated, totalCount }` metadata.
3. **Timed road segments, shared idle compression, and `FUZZED` wander:** `TrailPathSegment` carries optional `startedAt`, `endedAt`, and `vertexTimesMs` so **Clean (`roads`)** Timelapse animates in sync with real timestamps along snapped roads. Multi-member idle compression (`Compact` mode) compresses only intervals where *all* visible members are simultaneously stationary or gapped so multi-member clocks never drift. During `FUZZED` intervals, Timelapse renders the ~1 km fuzz radius with a `"Fuzzed"` badge and a deterministic bounded wander within that zone before seamlessly rejoining `EXACT` segments.

## Consequences

- Existing `TrailPathSegment` consumers remain backward-compatible because timing fields and response `meta` are additive and optional.
- `RoadTrailMatcher` tests and shared trip-splitting tests must account for 5-minute dwell boundaries separating consecutive trips.
