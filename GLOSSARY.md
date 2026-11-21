# LovedOnes

Self-hosted private group location sharing and messaging platform.

## Language

**Account**:
A registered identity with a system role (`HOST_ADMIN` or `USER`) authenticated via credentials and session tokens.
_Avoid_: User profile, client, login record

**Group**:
A named private circle within which Accounts share locations and chat messages.
_Avoid_: Room, circle, channel, team

**Membership**:
The association between an Account and a Group carrying a group role (`ADMIN`, `MEMBER`, or `SPECTATOR`) and a `PrivacyMode`.
_Avoid_: Subscription, participant, seat

**Invite**:
A time-bounded, usage-capped token that grants a specific group role when redeemed by an existing or newly registered Account.
_Avoid_: Referral, ticket, join code

**PrivacyMode**:
A per-Membership visibility rule (`EXACT`, `FUZZED`, or `GHOST`) governing how an Account's coordinates appear to fellow Group members.
_Avoid_: ACTIVE, FUZZED_1KM, visibility flag

**LocationPing**:
A timestamped geographic sample (`latitude`, `longitude`, optional `altitude`, `speed`, `batteryLevel`, and `recordedAt`) recorded by an Account's device.
_Avoid_: Coordinate, fix, beacon

**TelemetrySnapshot**:
A host-level diagnostic report aggregating log storage usage, spatial database footprint, and per-Account compute and socket counts.
_Avoid_: Metrics, health stats, analytics

**Host Admin (`HOST_ADMIN`)**:
The single-tier server owner system role (assigned automatically to the first registered Account) with host-wide `/admin` privileges (telemetry, live audit logs, log retention/pruning, registration approvals/removals, map region deletion, remote system updates, and server-wide invite/role override authority).
_Avoid_: Superuser, root account

**Group Admin (`ADMIN`)**:
Per-Membership Group role granted automatically to a Group's creator or via invite/promotion; manages invites, member roles, and geofenced `Place`s within that Group.
_Avoid_: Moderator, group owner

**Member (`MEMBER`)**:
Standard per-Membership Group role with full two-way location sharing (filtered by `PrivacyMode`), chat, check-in requests, and temporary `ShareLink` creation.
_Avoid_: Regular user, peer

**Spectator (`SPECTATOR`)**:
Read-only per-Membership Group role that can view Group map state, trails, places, and chat, but never shares live GPS, activates `EXACT` check-in overrides, or creates `ShareLink`s.
_Avoid_: Lurker, guest

**Standalone Account**:
A registered `USER` Account that currently has zero `Membership`s; may manage own profile/credentials/tracker token, join an existing Group via `Invite`, or create a new Group via `POST /api/auth/groups` (becoming that Group's `ADMIN`).
_Avoid_: Orphan user, pending user

**Guest (`ShareLink` Participant)**:
An unauthenticated external visitor accessing `/share/[token]` on a valid `ShareLink`; sees only that link creator's `PrivacyMode`-filtered pin plus fellow guests on the same token (if `allowGuestSharing` is enabled), isolated from private Group members and other links.
_Avoid_: Public user, spectator

**TrackerToken**:
A scoped `trk_...` token bound to one Account for headless HTTP location ingestion (`OwnTracks`, `Overland`, or direct `/api/realtime/locations`) without interactive login privileges.
_Avoid_: API key, session token

**Place**:
A Group-scoped named geofence circle (`center`, `radiusMeters`) managed by Group `ADMIN`s that records enter/exit transitions and triggers notifications.
_Avoid_: Zone, geofence, waypoint

**CheckInRequest**:
A Group-scoped time-bounded prompt asking another Group member (`MEMBER` or `ADMIN`) to temporarily override their `PrivacyMode` to `EXACT` (`privacyOverrideUntil`).
_Avoid_: Ping request, location demand

**ShareLink**:
A revocable, expiring temporary URL (`/share/[token]`) created by a `MEMBER` or `ADMIN` to share their live `PrivacyMode`-filtered location (and optionally mutual guest pins) without exposing their private Group.
_Avoid_: Invite link, group link

## Role & Actor Priority

- **System level (`users.role`):** `HOST_ADMIN` > `USER` (server-wide administration vs. standard self-service account).
- **Group level (`group_memberships.role`, per Group):** `ADMIN` > `MEMBER` > `SPECTATOR` (independent across different Groups).
- **Scoped / External actors:** Public `ShareLink` Guests and `TrackerToken` clients have strictly single-link or ingestion-only capabilities and zero Group/system access.
