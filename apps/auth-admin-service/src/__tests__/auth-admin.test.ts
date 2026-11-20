import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import WebSocket from 'ws';
import { createAuthAdminServer } from '../index.js';

const BASE_PG_URL = 'postgresql://postgres:postgres@localhost:5432';
const TEST_DB_NAME = 'lovedones_test_auth';
const TEST_DB_URL = `${BASE_PG_URL}/${TEST_DB_NAME}`;
const TEST_REDIS_URL = 'redis://localhost:6379/1';

async function recreateTestDatabase(dbName: string): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await adminPool.end();
  }
}

describe('@loved-ones/auth-admin-service integration', () => {
  let app: FastifyInstance;
  let logDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    await recreateTestDatabase(TEST_DB_NAME);
    const flushRedis = new Redis(TEST_REDIS_URL);
    await flushRedis.flushdb();
    await flushRedis.quit();

    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-auth-logs-'));
    const created = await createAuthAdminServer({
      databaseUrl: TEST_DB_URL,
      redisUrl: TEST_REDIS_URL,
      logDir,
      maxLogStorageMb: 50,
      publicServerUrl: 'https://track.example.com',
    });
    app = created.app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(logDir, { recursive: true, force: true });
    const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  });

  it('handles Argon2id registration, first-user HOST_ADMIN, QR invites, RBAC, telemetry, and live log streaming', async () => {
    // 1. Register first user -> HOST_ADMIN
    const regAdminRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'admin@lovedones.test',
        username: 'HostAdmin',
        password: 'SuperSecretPassword123',
      },
    });
    expect(regAdminRes.statusCode).toBe(201);
    const adminData = regAdminRes.json();
    expect(adminData.user.role).toBe('HOST_ADMIN');
    expect(adminData.accessToken).toBeTypeOf('string');
    expect(adminData.refreshToken).toBeTypeOf('string');

    // 2. Refresh token flow
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: adminData.refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().accessToken).toBeTypeOf('string');

    // 3. Create group
    const grpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/groups',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
      payload: { name: 'Family Circle' },
    });
    expect(grpRes.statusCode).toBe(201);
    const group = grpRes.json();
    expect(group.name).toBe('Family Circle');

    // 4. Generate QR invite
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
      payload: {
        groupId: group.id,
        assignedRole: 'MEMBER',
        maxUses: 2,
        expiresInHours: 12,
      },
    });
    expect(inviteRes.statusCode).toBe(201);
    const invite = inviteRes.json();
    expect(invite.v).toBe(1);
    expect(invite.serverUrl).toBe('https://track.example.com');
    expect(invite.inviteToken).toMatch(/^inv_/);
    expect(invite.groupName).toBe('Family Circle');
    expect(invite.joinUrl).toContain(`/join?token=${invite.inviteToken}`);

    // 5. Inspect invite publicly
    const lookupRes = await app.inject({
      method: 'GET',
      url: `/api/auth/invites/${invite.inviteToken}`,
    });
    expect(lookupRes.statusCode).toBe(200);
    expect(lookupRes.json().valid).toBe(true);

    // 6. Second user registers and joins via inviteToken
    const regMemberRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'member@lovedones.test',
        username: 'FamilyMember',
        password: 'MemberPassword123',
        inviteToken: invite.inviteToken,
      },
    });
    expect(regMemberRes.statusCode).toBe(201);
    const memberData = regMemberRes.json();
    expect(memberData.user.role).toBe('USER');
    expect(memberData.joinedGroup.groupId).toBe(group.id);

    // 7. Member updates privacy mode (using SPEC legacy alias FUZZED_1KM -> FUZZED)
    const privacyRes = await app.inject({
      method: 'PATCH',
      url: `/api/auth/groups/${group.id}/privacy`,
      headers: { Authorization: `Bearer ${memberData.accessToken}` },
      payload: { privacy: 'FUZZED_1KM' },
    });
    expect(privacyRes.statusCode).toBe(200);
    expect(privacyRes.json().privacy).toBe('FUZZED');

    // 8. Member cannot access admin telemetry (403)
    const forbiddenRes = await app.inject({
      method: 'GET',
      url: '/api/admin/telemetry',
      headers: { Authorization: `Bearer ${memberData.accessToken}` },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // 9. HostAdmin fetches telemetry
    // Give background Redis logger/telemetry pipeline a brief tick
    await new Promise((r) => setTimeout(r, 50));
    const telemetryRes = await app.inject({
      method: 'GET',
      url: '/api/admin/telemetry',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(telemetryRes.statusCode).toBe(200);
    const telemetry = telemetryRes.json();
    expect(telemetry.databaseBytes).toBeGreaterThan(0);
    expect(telemetry.logStorageBytes).toBeGreaterThan(0);
    expect(telemetry.users.length).toBe(2);
    const trackedAdmin = telemetry.users.find(
      (u: { userId: string }) => u.userId === adminData.user.id,
    );
    expect(trackedAdmin.eventsCount).toBeGreaterThan(0);
    expect(trackedAdmin.redisMemoryBytes).toBeGreaterThan(0);

    // 10. Live WebSocket log stream returns NDJSON logs
    const wsUrl = baseUrl.replace('http://', 'ws://') + `/api/admin/logs/stream?token=${adminData.accessToken}`;
    const receivedLine = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for log stream message'));
      }, 4000);
      ws.on('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(JSON.parse(receivedLine).service).toBe('auth-admin-service');

    // 11. Account Settings: update username, email, avatarUrl & password
    const avatarPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { Authorization: `Bearer ${memberData.accessToken}` },
      payload: {
        username: 'FamilyRenamed',
        email: 'member.new@lovedones.test',
        avatarUrl: avatarPng,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json();
    expect(patched.user.username).toBe('FamilyRenamed');
    expect(patched.user.email).toBe('member.new@lovedones.test');
    expect(patched.user.avatarUrl).toBe(avatarPng);
    expect(patched.accessToken).toBeTypeOf('string');

    const badPwRes = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
      payload: {
        currentPassword: 'WrongPassword',
        newPassword: 'MemberNewPassword456',
      },
    });
    expect(badPwRes.statusCode).toBe(401);

    const okPwRes = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
      payload: {
        currentPassword: 'MemberPassword123',
        newPassword: 'MemberNewPassword456',
      },
    });
    expect(okPwRes.statusCode).toBe(200);

    const loginNewRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'member.new@lovedones.test',
        password: 'MemberNewPassword456',
      },
    });
    expect(loginNewRes.statusCode).toBe(200);
    expect(loginNewRes.json().user.avatarUrl).toBe(avatarPng);

    // 12. Admin invite deletion & RBAC check
    const memberDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/admin/invites/${invite.inviteToken}`,
      headers: { Authorization: `Bearer ${memberData.accessToken}` },
    });
    expect(memberDeleteRes.statusCode).toBe(403);

    const adminDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/admin/invites/${invite.inviteToken}`,
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(adminDeleteRes.statusCode).toBe(200);
    expect(adminDeleteRes.json()).toEqual({ deleted: true, token: invite.inviteToken });

    const previewDeletedRes = await app.inject({
      method: 'GET',
      url: `/api/auth/invites/${invite.inviteToken}`,
    });
    expect(previewDeletedRes.statusCode).toBe(404);
  });
});
