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
