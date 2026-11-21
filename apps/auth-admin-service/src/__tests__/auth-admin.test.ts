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
  const sentEmails: Array<{ to: string; subject: string; text: string }> = [];
  let updaterApplyCount = 0;

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
      emailSender: {
        isConfigured: () => true,
        async sendMail(msg) {
          sentEmails.push({ to: msg.to, subject: msg.subject, text: msg.text });
        },
      },
      systemUpdater: {
        driver: {
          async getStatus(refresh) {
            return {
              enabled: true,
              disabledReason: null,
              phase: updaterApplyCount > 0 ? 'pulling' : 'idle',
              running: updaterApplyCount > 0,
              branch: 'main',
              currentCommit: 'be116f1',
              currentCommitMessage: 'feat(trails): average nearby stationary trail pings',
              upstreamBranch: 'origin/main',
              remoteCommit: 'c0ffee1',
              commitsBehind: 1,
              pendingCommits: [
                { sha: 'c0ffee1', message: 'feat: remote system updater', author: 'Admin' },
              ],
              updateAvailable: true,
              workingTreeDirty: false,
              lastCheckedAt: refresh ? '2026-11-20T21:35:00.000Z' : null,
              startedAt: updaterApplyCount > 0 ? '2026-11-20T21:35:10.000Z' : null,
              finishedAt: null,
              targetCommit: updaterApplyCount > 0 ? 'c0ffee1' : null,
              error: null,
              logs: updaterApplyCount > 0 ? ['Pulling origin/main...'] : [],
            };
          },
          async applyUpdate() {
            updaterApplyCount += 1;
            return {
              statusCode: 202,
              status: {
                enabled: true,
                disabledReason: null,
                phase: 'pulling',
                running: true,
                branch: 'main',
                currentCommit: 'be116f1',
                currentCommitMessage: 'feat(trails): average nearby stationary trail pings',
                upstreamBranch: 'origin/main',
                remoteCommit: 'c0ffee1',
                commitsBehind: 1,
                pendingCommits: [
                  { sha: 'c0ffee1', message: 'feat: remote system updater', author: 'Admin' },
                ],
                updateAvailable: true,
                workingTreeDirty: false,
                lastCheckedAt: '2026-11-20T21:35:00.000Z',
                startedAt: '2026-11-20T21:35:10.000Z',
                finishedAt: null,
                targetCommit: 'c0ffee1',
                error: null,
                logs: ['Pulling origin/main...'],
              },
            };
          },
        },
      },
      appVersion: {
        serverVersion: '0.2.0',
        latestMobileVersion: '0.2.0',
        minSupportedVersion: '0.1.5',
        downloadUrl: 'https://github.com/Dowiw/LovedOnes/releases/latest',
      },
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

    // Verify recent audit logs include full human-readable context (username, groupName, privacy change)
    const recentLogsRes = await app.inject({
      method: 'GET',
      url: '/api/admin/logs/recent',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(recentLogsRes.statusCode).toBe(200);
    const recentLogs = recentLogsRes.json().logs as string[];
    const privacyLogLine = recentLogs.find((line) => line.includes('"group.privacy_updated"'));
    expect(privacyLogLine).toBeTruthy();
    const privacyLogObj = JSON.parse(privacyLogLine!);
    expect(privacyLogObj.username).toBe('FamilyMember');
    expect(privacyLogObj.groupName).toBe('Family Circle');
    expect(privacyLogObj.previousPrivacy).toBe('EXACT');
    expect(privacyLogObj.privacy).toBe('FUZZED');
    expect(privacyLogObj.msg).toContain('FamilyMember switched privacy in group "Family Circle" from EXACT to FUZZED');

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
        haloColor: '#0ea5e9',
        fuzzCircleColor: '#8b5cf6',
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json();
    expect(patched.user.username).toBe('FamilyRenamed');
    expect(patched.user.email).toBe('member.new@lovedones.test');
    expect(patched.user.avatarUrl).toBe(avatarPng);
    expect(patched.user.haloColor).toBe('#0ea5e9');
    expect(patched.user.fuzzCircleColor).toBe('#8b5cf6');
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

    // 11b. Backup recovery email verification + forgot password reset flow
    const sendRecoveryRes = await app.inject({
      method: 'POST',
      url: '/api/auth/recovery-email/send-code',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
      payload: { recoveryEmail: 'member.backup@lovedones.test' },
    });
    expect(sendRecoveryRes.statusCode).toBe(200);
    const verifyMail = sentEmails.find((m) => m.to === 'member.backup@lovedones.test');
    const verifyOtp = verifyMail?.text.match(/\b(\d{6})\b/)?.[1];
    expect(verifyOtp).toBeTruthy();

    const verifyRecoveryRes = await app.inject({
      method: 'POST',
      url: '/api/auth/recovery-email/verify',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
      payload: {
        recoveryEmail: 'member.backup@lovedones.test',
        code: verifyOtp,
      },
    });
    expect(verifyRecoveryRes.statusCode).toBe(200);
    expect(verifyRecoveryRes.json().verified).toBe(true);
    expect(verifyRecoveryRes.json().user.recoveryEmailVerified).toBe(true);

    const forgotReqRes = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password/request',
      payload: { email: 'member.new@lovedones.test' },
    });
    expect(forgotReqRes.statusCode).toBe(200);
    const resetMail = sentEmails.filter((m) => m.to === 'member.backup@lovedones.test').at(-1);
    const resetOtp = resetMail?.text.match(/\b(\d{6})\b/)?.[1];
    expect(resetOtp).toBeTruthy();

    const forgotResetRes = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password/reset',
      payload: {
        email: 'member.backup@lovedones.test',
        code: resetOtp,
        newPassword: 'MemberResetPassword789',
      },
    });
    expect(forgotResetRes.statusCode).toBe(200);
    expect(forgotResetRes.json()).toEqual({ reset: true });

    const loginResetRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'member.new@lovedones.test',
        password: 'MemberResetPassword789',
      },
    });
    expect(loginResetRes.statusCode).toBe(200);
    expect(loginResetRes.json().user.recoveryEmailVerified).toBe(true);

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

    // 13. Host Admin remote system update RBAC, status check, and trigger audit logging
    const memberUpdateRes = await app.inject({
      method: 'GET',
      url: '/api/admin/system/update',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
    });
    expect(memberUpdateRes.statusCode).toBe(403);

    const memberTriggerRes = await app.inject({
      method: 'POST',
      url: '/api/admin/system/update',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
      payload: {},
    });
    expect(memberTriggerRes.statusCode).toBe(403);

    const adminUpdateCheckRes = await app.inject({
      method: 'GET',
      url: '/api/admin/system/update?refresh=1',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(adminUpdateCheckRes.statusCode).toBe(200);
    expect(adminUpdateCheckRes.json()).toMatchObject({
      enabled: true,
      updateAvailable: true,
      commitsBehind: 1,
      remoteCommit: 'c0ffee1',
    });

    const adminTriggerRes = await app.inject({
      method: 'POST',
      url: '/api/admin/system/update',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
      payload: { rebuildEvenIfCurrent: false },
    });
    expect(adminTriggerRes.statusCode).toBe(202);
    expect(adminTriggerRes.json()).toMatchObject({
      running: true,
      phase: 'pulling',
      targetCommit: 'c0ffee1',
    });
    expect(updaterApplyCount).toBe(1);

    // 14. Outdated APK/IPA & Web client version check endpoint
    const outdatedApkRes = await app.inject({
      method: 'GET',
      url: '/api/auth/app-version?platform=android&version=0.1.0',
    });
    expect(outdatedApkRes.statusCode).toBe(200);
    expect(outdatedApkRes.json()).toMatchObject({
      serverVersion: '0.2.0',
      latestMobileVersion: '0.2.0',
      minSupportedVersion: '0.1.5',
      updateAvailable: true,
      updateRequired: true,
      downloadUrl: 'https://github.com/Dowiw/LovedOnes/releases/latest',
    });

    const currentApkRes = await app.inject({
      method: 'GET',
      url: '/api/auth/app-version?platform=ios&version=0.2.0',
    });
    expect(currentApkRes.statusCode).toBe(200);
    expect(currentApkRes.json()).toMatchObject({
      updateAvailable: false,
      updateRequired: false,
    });

    // 15. Configurable Log Retention policy & manual pruning (Host Admin only)
    const memberRetentionRes = await app.inject({
      method: 'GET',
      url: '/api/admin/logs/retention',
      headers: { Authorization: `Bearer ${patched.accessToken}` },
    });
    expect(memberRetentionRes.statusCode).toBe(403);

    const expiredLogPath = path.join(logDir, 'realtime-service.log.99');
    fs.writeFileSync(expiredLogPath, 'stale\n', 'utf8');
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(expiredLogPath, oldDate, oldDate);

    const updateRetentionRes = await app.inject({
      method: 'PATCH',
      url: '/api/admin/logs/retention',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
      payload: {
        retentionDays: 3,
        maxFilesPerService: 5,
        maxRecentEntries: 250,
        maxStorageMb: 250,
        autoPruneDiskLogs: true,
      },
    });
    expect(updateRetentionRes.statusCode).toBe(200);
    expect(updateRetentionRes.json().settings).toMatchObject({
      retentionDays: 3,
      maxFilesPerService: 5,
      maxRecentEntries: 250,
      maxStorageMb: 250,
      autoPruneDiskLogs: true,
    });
    expect(updateRetentionRes.json().deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(expiredLogPath)).toBe(false);

    const telAfterRetention = await app.inject({
      method: 'GET',
      url: '/api/admin/telemetry',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(telAfterRetention.statusCode).toBe(200);
    expect(telAfterRetention.json().maxLogStorageBytes).toBe(250 * 1024 * 1024);

    const manualPruneRes = await app.inject({
      method: 'POST',
      url: '/api/admin/logs/prune',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(manualPruneRes.statusCode).toBe(200);
    expect(manualPruneRes.json().settings.retentionDays).toBe(3);

    // 16. Onboarding IP handshake + 1-per-IP 24h admin-approved registration requests
    const memberReqListForbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/registration-requests',
      headers: { Authorization: `Bearer ${memberData.accessToken}` },
    });
    expect(memberReqListForbidden.statusCode).toBe(403);

    const handshakeBefore = await app.inject({
      method: 'POST',
      url: '/api/auth/onboarding/handshake',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: {},
    });
    expect(handshakeBefore.statusCode).toBe(200);
    expect(handshakeBefore.json()).toMatchObject({
      ok: true,
      requesterIp: '203.0.113.10',
      alreadyPinged: false,
      activeRequest: null,
    });

    const createReqRes = await app.inject({
      method: 'POST',
      url: '/api/auth/registration-requests',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: {
        username: 'PendingCasey',
        email: 'casey@example.com',
        password: 'CaseyPassword123!',
        avatarUrl: 'https://cdn.example.com/casey.png',
        haloColor: '#0EA5E9',
      },
    });
    expect(createReqRes.statusCode).toBe(201);
    const createdReq = createReqRes.json().request;
    expect(createdReq.status).toBe('PENDING');
    expect(createdReq.requesterIp).toBe('203.0.113.10');
    expect(createdReq.haloColor).toBe('#0ea5e9');
    expect(new Date(createdReq.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);

    // Same IP cannot submit a second pending request or re-ping as fresh
    const duplicateIpReq = await app.inject({
      method: 'POST',
      url: '/api/auth/registration-requests',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: {
        username: 'AnotherUser',
        email: 'another@example.com',
        password: 'AnotherPassword123!',
      },
    });
    expect(duplicateIpReq.statusCode).toBe(409);
    expect(duplicateIpReq.json().details?.activeRequest?.id).toBe(createdReq.id);

    const handshakeAfter = await app.inject({
      method: 'POST',
      url: '/api/auth/onboarding/handshake',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: {},
    });
    expect(handshakeAfter.statusCode).toBe(200);
    expect(handshakeAfter.json().alreadyPinged).toBe(true);
    expect(handshakeAfter.json().activeRequest?.id).toBe(createdReq.id);

    // Different IP can submit a request that admin denies
    const secondReqRes = await app.inject({
      method: 'POST',
      url: '/api/auth/registration-requests',
      headers: { 'x-forwarded-for': '203.0.113.22' },
      payload: {
        username: 'DeniedDana',
        email: 'dana@example.com',
        password: 'DanaPassword123!',
      },
    });
    expect(secondReqRes.statusCode).toBe(201);
    const secondReq = secondReqRes.json().request;

    const adminListRes = await app.inject({
      method: 'GET',
      url: '/api/admin/registration-requests',
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(adminListRes.statusCode).toBe(200);
    expect(adminListRes.json().requests.length).toBeGreaterThanOrEqual(2);

    // Admin approves Casey -> Casey can now sign in with chosen profile/color
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/admin/registration-requests/${createdReq.id}/approve`,
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().request.status).toBe('APPROVED');

    const caseyStatusRes = await app.inject({
      method: 'GET',
      url: `/api/auth/registration-requests/status?id=${createdReq.id}`,
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(caseyStatusRes.statusCode).toBe(200);
    expect(caseyStatusRes.json().request?.status).toBe('APPROVED');

    const caseyLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'casey@example.com', password: 'CaseyPassword123!' },
    });
    expect(caseyLoginRes.statusCode).toBe(200);
    expect(caseyLoginRes.json().user).toMatchObject({
      username: 'PendingCasey',
      avatarUrl: 'https://cdn.example.com/casey.png',
      haloColor: '#0ea5e9',
    });

    // Admin denies Dana -> status reflects DENIED
    const denyRes = await app.inject({
      method: 'POST',
      url: `/api/admin/registration-requests/${secondReq.id}/deny`,
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(denyRes.statusCode).toBe(200);
    expect(denyRes.json().request.status).toBe('DENIED');

    // 17. Admin removes Casey's profile -> stale tokens immediately fail with ACCOUNT_REMOVED
    const caseyId = caseyLoginRes.json().user.id as string;
    const caseyAccess = caseyLoginRes.json().accessToken as string;

    const selfDeleteForbidden = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${adminData.user.id}`,
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(selfDeleteForbidden.statusCode).toBe(400);

    const deleteCaseyRes = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${caseyId}`,
      headers: { Authorization: `Bearer ${adminData.accessToken}` },
    });
    expect(deleteCaseyRes.statusCode).toBe(200);
    expect(deleteCaseyRes.json()).toMatchObject({ ok: true, removedUserId: caseyId });

    const caseyAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { Authorization: `Bearer ${caseyAccess}` },
    });
    expect(caseyAfterDelete.statusCode).toBe(401);
    expect(caseyAfterDelete.json().code).toBe('ACCOUNT_REMOVED');
  });
});
