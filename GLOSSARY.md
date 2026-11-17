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
