CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

DO $$ BEGIN
    CREATE TYPE system_role AS ENUM ('HOST_ADMIN', 'USER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE group_role AS ENUM ('ADMIN', 'MEMBER', 'SPECTATOR');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE privacy_mode AS ENUM ('EXACT', 'FUZZED', 'GHOST');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(64) NOT NULL,
    password_hash TEXT NOT NULL,
    role system_role DEFAULT 'USER',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_memberships (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    role group_role DEFAULT 'MEMBER',
    privacy privacy_mode DEFAULT 'EXACT',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS group_invites (
    token VARCHAR(128) PRIMARY KEY,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    assigned_role group_role DEFAULT 'MEMBER',
    created_by UUID REFERENCES users(id) ON DELETE CASCADE,
    max_uses INT DEFAULT 1,
    uses INT DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS location_history (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    coords GEOGRAPHY(Point, 4326) NOT NULL,
    altitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    battery_level SMALLINT,
    recorded_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_user_time ON location_history (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_gist ON location_history USING GIST (coords);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_location_user_recorded_unique'
    ) THEN
        DELETE FROM location_history a
        USING location_history b
        WHERE a.id > b.id
          AND a.user_id = b.user_id
          AND a.recorded_at = b.recorded_at;

        CREATE UNIQUE INDEX idx_location_user_recorded_unique
        ON location_history (user_id, recorded_at);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, created_at DESC);

ALTER TABLE group_memberships
    ADD COLUMN IF NOT EXISTS privacy_override_until TIMESTAMPTZ NULL;

DO $$ BEGIN
    CREATE TYPE location_request_status AS ENUM ('pending', 'accepted', 'declined', 'expired');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS location_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status location_request_status NOT NULL DEFAULT 'pending',
    suggested_duration_minutes INT NOT NULL DEFAULT 15,
    message VARCHAR(240),
    expires_at TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_requests_group_target
    ON location_requests (group_id, target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS group_places (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    center GEOGRAPHY(Point, 4326) NOT NULL,
    radius_meters DOUBLE PRECISION NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_places_group ON group_places (group_id);
CREATE INDEX IF NOT EXISTS idx_group_places_gist ON group_places USING GIST (center);

DO $$ BEGIN
    CREATE TYPE place_transition_type AS ENUM ('enter', 'exit');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS group_place_states (
    place_id UUID NOT NULL REFERENCES group_places(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_inside BOOLEAN NOT NULL,
    last_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (place_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_place_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    place_id UUID NOT NULL REFERENCES group_places(id) ON DELETE CASCADE,
    place_name VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transition place_transition_type NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_place_events_group_time
    ON group_place_events (group_id, created_at DESC);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_url TEXT NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS recovery_email VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS recovery_email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_recovery_email_lower
    ON users (LOWER(recovery_email));

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS halo_color VARCHAR(7) NULL,
    ADD COLUMN IF NOT EXISTS fuzz_circle_color VARCHAR(7) NULL;

ALTER TABLE group_places
    ALTER COLUMN group_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_group_places_created_by
    ON group_places (created_by)
    WHERE is_private = TRUE;

DO $$ BEGIN
    CREATE TYPE registration_request_status AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS registration_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    username VARCHAR(64) NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT NULL,
    halo_color VARCHAR(7) NULL,
    fuzz_circle_color VARCHAR(7) NULL,
    invite_token VARCHAR(128) NULL REFERENCES group_invites(token) ON DELETE SET NULL,
    group_name VARCHAR(100) NULL,
    requester_ip VARCHAR(128) NOT NULL,
    status registration_request_status NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registration_requests_ip_status
    ON registration_requests (requester_ip, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_requests_status_created
    ON registration_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS push_vapid_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT 'mailto:admin@lovedones.local',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS location_share_links (
    token VARCHAR(96) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    label VARCHAR(80) NULL,
    allow_guest_sharing BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_share_links_user_active
    ON location_share_links (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS location_share_guests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    share_token VARCHAR(96) NOT NULL REFERENCES location_share_links(token) ON DELETE CASCADE,
    guest_secret VARCHAR(96) NOT NULL,
    display_name VARCHAR(40) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_share_guests_token_updated
    ON location_share_guests (share_token, updated_at DESC);

ALTER TABLE location_history
    ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION NULL,
    ADD COLUMN IF NOT EXISTS heading DOUBLE PRECISION NULL,
    ADD COLUMN IF NOT EXISTS activity VARCHAR(24) NULL;

CREATE TABLE IF NOT EXISTS server_settings (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NULL,
    updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS map_download_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_username VARCHAR(64) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    city_name VARCHAR(120) NULL,
    display_name VARCHAR(200) NULL,
    radius_km DOUBLE PRECISION NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    job_id VARCHAR(64) NULL,
    reviewed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by_username VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_map_download_requests_status_created
    ON map_download_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_map_download_requests_requester
    ON map_download_requests (requester_id, created_at DESC);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_users_username_lower'
    ) THEN
        WITH ranked AS (
            SELECT id,
                   username,
                   ROW_NUMBER() OVER (
                       PARTITION BY LOWER(username)
                       ORDER BY created_at ASC, id ASC
                   ) AS rn
            FROM users
        )
        UPDATE users u
        SET username = LEFT(r.username, 56) || '_' || r.rn::text || '_' || SUBSTRING(REPLACE(u.id::text, '-', ''), 1, 4)
        FROM ranked r
        WHERE u.id = r.id
          AND r.rn > 1;

        CREATE UNIQUE INDEX idx_users_username_lower
        ON users (LOWER(username));
    END IF;
END $$;
