import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GroupRole, PrivacyMode, SystemRole } from '@loved-ones/shared';
import { createTokenService } from '@loved-ones/shared/auth';
import {
  AccountRecord,
  AuthGroupModule,
  AuthGroupStore,
  AuthGroupTxStore,
  GroupWithMembers,
  InviteRecord,
  MembershipSummaryRecord,
  PasswordHasher,
  PublicAccountRecord,
  SessionStore,
} from '../domain/auth-group-module.js';
import { TelemetryQueryModule, TelemetryQueryStore } from '../domain/telemetry-query-module.js';

function createInMemoryAuthGroupStore(): AuthGroupStore & {
  accounts: Map<string, AccountRecord>;
  invites: Map<string, InviteRecord>;
} {
  const accounts = new Map<string, AccountRecord>();
  const groups = new Map<string, { id: string; name: string; createdBy: string; createdAt: Date }>();
  const memberships = new Map<
    string,
    { userId: string; groupId: string; role: GroupRole; privacy: PrivacyMode; joinedAt: Date }
  >();
  const invites = new Map<string, InviteRecord>();

  const mKey = (userId: string, groupId: string) => `${userId}:${groupId}`;

  const txStore: AuthGroupTxStore = {
    async findAccountByEmail(email) {
      const lower = email.toLowerCase();
      for (const acc of accounts.values()) {
        if (acc.email.toLowerCase() === lower) return acc;
      }
      return null;
    },
    async countAccounts() {
      return accounts.size;
    },
    async insertAccount(input) {
      const acc: AccountRecord = {
        id: crypto.randomUUID(),
        email: input.email,
        username: input.username,
        passwordHash: input.passwordHash,
        role: input.role,
        avatarUrl: null,
        recoveryEmail: null,
        recoveryEmailVerified: false,
        createdAt: new Date('2026-11-17T12:00:00Z'),
      };
      accounts.set(acc.id, acc);
      const { passwordHash: _ignored, ...pub } = acc;
      return pub;
    },
    async findInviteForUpdate(token) {
      return invites.get(token) ?? null;
    },
    async findMembership(userId, groupId) {
      const m = memberships.get(mKey(userId, groupId));
      return m ? { role: m.role, privacy: m.privacy } : null;
    },
    async insertMembership(input) {
      memberships.set(mKey(input.userId, input.groupId), {
        userId: input.userId,
        groupId: input.groupId,
        role: input.role,
        privacy: input.privacy,
        joinedAt: new Date('2026-11-17T12:00:00Z'),
      });
    },
    async incrementInviteUses(token) {
      const inv = invites.get(token);
      if (inv) inv.uses += 1;
    },
    async insertGroup(name, createdBy) {
      const grp = {
        id: crypto.randomUUID(),
        name,
        createdBy,
        createdAt: new Date('2026-11-17T12:00:00Z'),
      };
      groups.set(grp.id, grp);
      return { id: grp.id, name: grp.name, createdAt: grp.createdAt };
    },
  };

  return {
    accounts,
    invites,
    async withTransaction(fn) {
      // Snapshot rollback simulation for atomic registration error tests
      const snapAccounts = new Map(accounts);
      const snapGroups = new Map(groups);
      const snapMemberships = new Map(memberships);
      const snapInvites = new Map(
        Array.from(invites.entries()).map(([k, v]) => [k, { ...v }]),
      );
      try {
        return await fn(txStore);
      } catch (err) {
        accounts.clear();
        snapAccounts.forEach((v, k) => accounts.set(k, v));
        groups.clear();
        snapGroups.forEach((v, k) => groups.set(k, v));
        memberships.clear();
        snapMemberships.forEach((v, k) => memberships.set(k, v));
        invites.clear();
        snapInvites.forEach((v, k) => invites.set(k, v));
        throw err;
      }
    },
    findAccountByEmail: txStore.findAccountByEmail,
    async findAccountByVerifiedRecoveryEmail(recoveryEmail) {
      const lower = recoveryEmail.toLowerCase();
      for (const acc of accounts.values()) {
        if (acc.recoveryEmail?.toLowerCase() === lower && acc.recoveryEmailVerified) {
          return acc;
        }
      }
      return null;
    },
    async findAccountById(id): Promise<PublicAccountRecord | null> {
      const acc = accounts.get(id);
      if (!acc) return null;
      const { passwordHash: _ignored, ...pub } = acc;
      return pub;
    },
    async findAccountWithPasswordById(id): Promise<AccountRecord | null> {
      return accounts.get(id) ?? null;
    },
    async updateAccountProfile(userId, patch) {
      const acc = accounts.get(userId);
      if (!acc) return { status: 'not_found' as const };
      if (patch.email !== undefined) {
        const lower = patch.email.toLowerCase();
        for (const other of accounts.values()) {
          if (other.id !== userId && other.email.toLowerCase() === lower) {
            return { status: 'email_conflict' as const };
          }
        }
        acc.email = lower;
      }
      if (patch.username !== undefined) acc.username = patch.username;
      if (patch.avatarUrl !== undefined) acc.avatarUrl = patch.avatarUrl;
      const { passwordHash: _ignored, ...pub } = acc;
      return { status: 'ok' as const, account: pub };
    },
    async updateRecoveryEmail(userId, recoveryEmail, verified) {
      const acc = accounts.get(userId);
      if (!acc) return null;
      acc.recoveryEmail = recoveryEmail;
      acc.recoveryEmailVerified = verified;
      const { passwordHash: _ignored, ...pub } = acc;
      return pub;
    },
    async updateAccountPassword(userId, passwordHash) {
      const acc = accounts.get(userId);
      if (!acc) return false;
      acc.passwordHash = passwordHash;
      return true;
    },
    async listAccountMemberships(userId): Promise<MembershipSummaryRecord[]> {
      const result: MembershipSummaryRecord[] = [];
      for (const m of memberships.values()) {
        if (m.userId !== userId) continue;
        const g = groups.get(m.groupId);
        if (!g) continue;
        result.push({
          groupId: g.id,
          name: g.name,
          role: m.role,
          privacy: m.privacy,
          joinedAt: m.joinedAt,
        });
      }
      return result;
    },
    async listGroupsWithMembers(userId): Promise<GroupWithMembers[]> {
      const result: GroupWithMembers[] = [];
      for (const m of memberships.values()) {
        if (m.userId !== userId) continue;
        const g = groups.get(m.groupId);
        if (!g) continue;
        const members = Array.from(memberships.values())
          .filter((entry) => entry.groupId === g.id)
          .map((entry) => ({
            userId: entry.userId,
            username: accounts.get(entry.userId)?.username ?? 'Unknown',
            avatarUrl: accounts.get(entry.userId)?.avatarUrl ?? null,
            role: entry.role,
            privacy: entry.privacy,
            joinedAt: entry.joinedAt.toISOString(),
          }));
        result.push({
          id: g.id,
          name: g.name,
          createdAt: g.createdAt.toISOString(),
          myRole: m.role,
          myPrivacy: m.privacy,
          members,
        });
      }
      return result;
    },
    findInviteByToken: txStore.findInviteForUpdate,
    async findGroupById(groupId) {
      const g = groups.get(groupId);
      return g ? { id: g.id, name: g.name } : null;
    },
    findMembership: txStore.findMembership,
    async hasAnyAdminMembership(userId) {
      for (const m of memberships.values()) {
        if (m.userId === userId && m.role === 'ADMIN') return true;
      }
      return false;
    },
    async updateMembershipPrivacy(userId, groupId, privacy) {
      const m = memberships.get(mKey(userId, groupId));
      if (!m) return null;
      m.privacy = privacy;
      return m.privacy;
    },
    async updateMembershipRole(userId, groupId, role) {
      const m = memberships.get(mKey(userId, groupId));
      if (!m) return null;
      m.role = role;
      return { userId, role };
    },
    async insertInvite(input) {
      const g = groups.get(input.groupId);
      invites.set(input.token, {
        token: input.token,
        groupId: input.groupId,
        groupName: g?.name ?? 'Unknown',
        assignedRole: input.assignedRole,
        maxUses: input.maxUses,
        uses: 0,
        expiresAt: input.expiresAt,
      });
    },
    async listInvites(caller) {
      const all = Array.from(invites.values());
      if (caller.systemRole === 'HOST_ADMIN') return all;
      return all.filter((inv) => memberships.get(mKey(caller.userId, inv.groupId))?.role === 'ADMIN');
    },
    async deleteInvite(token) {
      return invites.delete(token);
    },
  };
}

const fastHasher: PasswordHasher = {
  async hash(password) {
    return `hashed:${password}`;
  },
  async verify(hash, password) {
    return hash === `hashed:${password}`;
  },
};

function createTestHarness(publicServerUrl = 'https://track.example.com', nowMs = 1_700_000_000_000) {
  let currentMs = nowMs;
  const store = createInMemoryAuthGroupStore();
  const savedSessions: string[] = [];
  const activeTrackerJtis = new Map<string, { jti: string; ttlSeconds: number }>();
  const sessionStore: SessionStore = {
    async saveSession(account) {
      savedSessions.push(account.id);
    },
    async saveTrackerTokenJti(userId, jti, expiresInDays) {
      activeTrackerJtis.set(userId, { jti, ttlSeconds: expiresInDays * 86400 });
    },
    async revokeTrackerTokenJti(userId) {
      activeTrackerJtis.delete(userId);
    },
    async getTrackerTokenStatus(userId) {
      const entry = activeTrackerJtis.get(userId);
      return entry
        ? { active: true, ttlSeconds: entry.ttlSeconds }
        : { active: false, ttlSeconds: 0 };
    },
  };
  const tokenService = createTokenService({
    jwtSecret: 'test-access-secret-minimum-32-chars!!',
    jwtRefreshSecret: 'test-refresh-secret-minimum-32-chars!',
  });

  const mod = new AuthGroupModule({
    store,
    sessionStore,
    tokenService,
    publicServerUrl,
    passwordHasher: fastHasher,
    now: () => currentMs,
  });

  return {
    mod,
    store,
    sessionStore,
    savedSessions,
    tokenService,
    advanceMs(delta: number) {
      currentMs += delta;
    },
  };
}

describe('AuthGroupModule domain interface', () => {
  it('promotes first account to HOST_ADMIN, assigns USER to second, and rejects duplicate email', async () => {
    const { mod } = createTestHarness();

    const first = await mod.register({
      email: 'host@example.com',
      username: 'Host',
      password: 'Password1234',
    });
    expect(first.user.role).toBe('HOST_ADMIN');

    const second = await mod.register({
      email: 'member@example.com',
      username: 'Member',
      password: 'Password1234',
    });
    expect(second.user.role).toBe('USER');

    await expect(
      mod.register({
        email: 'HOST@example.com',
        username: 'Dup',
        password: 'Password1234',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rolls back registration cleanly if inviteToken is invalid or expired', async () => {
    const { mod, store } = createTestHarness();
    await expect(
      mod.register({
        email: 'rolledback@example.com',
        username: 'Ghost',
        password: 'Password1234',
        inviteToken: 'inv_missing_token',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(store.accounts.size).toBe(0);
  });

  it('enforces strict access vs refresh JWT validation and handles login/refresh', async () => {
    const { mod, tokenService } = createTestHarness();
    const reg = await mod.register({
      email: 'alice@example.com',
      username: 'Alice',
      password: 'Password1234',
    });

    await expect(
      mod.login({ email: 'alice@example.com', password: 'WrongPassword' }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      mod.refresh({ refreshToken: reg.accessToken }),
    ).rejects.toMatchObject({ statusCode: 401 });

    const refreshed = await mod.refresh({ refreshToken: reg.refreshToken });
    const claims = await tokenService.verifyAccessToken(refreshed.tokens.accessToken);
    expect(claims.id).toBe(reg.user.id);
    expect(claims.type).toBe('access');
  });

  it('enforces RBAC, invite expiration/exhaustion, and prevents role downgrade on re-join', async () => {
    const { mod, store, advanceMs } = createTestHarness();
    const admin = await mod.register({
      email: 'admin@example.com',
      username: 'Admin',
      password: 'Password1234',
    });
    const member = await mod.register({
      email: 'member@example.com',
      username: 'Member',
      password: 'Password1234',
    });
    const outsider = await mod.register({
      email: 'outsider@example.com',
      username: 'Outsider',
      password: 'Password1234',
    });

    const group = await mod.createGroup(admin.user.id, { name: 'Family' });

    const memberClaims = {
      id: member.user.id,
      email: member.user.email,
      username: member.user.username,
      role: 'USER' as SystemRole,
    };

    // Non-admin cannot pass assertAdmin or update roles
    await expect(mod.assertAdmin(memberClaims)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      mod.createInvite(memberClaims, {
        groupId: group.id,
        assignedRole: 'MEMBER',
        maxUses: 1,
        expiresInHours: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const adminClaims = {
      id: admin.user.id,
      email: admin.user.email,
      username: admin.user.username,
      role: 'HOST_ADMIN' as SystemRole,
    };

    const invite = await mod.createInvite(
      adminClaims,
      { groupId: group.id, assignedRole: 'MEMBER', maxUses: 1, expiresInHours: 1 },
      'http://localhost:8080',
    );
    // Non-localhost PUBLIC_SERVER_URL wins over localhost Origin
    expect(invite.serverUrl).toBe('https://track.example.com');

    // Existing ADMIN joining their own group via MEMBER invite keeps ADMIN & does not burn use
    const adminRejoin = await mod.joinByInvite(admin.user.id, {
      inviteToken: invite.inviteToken,
    });
    expect(adminRejoin.role).toBe('ADMIN');
    expect(adminRejoin.alreadyMember).toBe(true);
    expect(store.invites.get(invite.inviteToken)?.uses).toBe(0);

    // Member joins once -> consumes the 1 use; outsider is blocked (exhausted)
    const joined = await mod.joinByInvite(member.user.id, { inviteToken: invite.inviteToken });
    expect(joined.alreadyMember).toBe(false);
    expect(store.invites.get(invite.inviteToken)?.uses).toBe(1);

    await expect(
      mod.joinByInvite(outsider.user.id, { inviteToken: invite.inviteToken }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Expired invite is rejected
    const expInvite = await mod.createInvite(adminClaims, {
      groupId: group.id,
      assignedRole: 'SPECTATOR',
      maxUses: 5,
      expiresInHours: 1,
    });
    advanceMs(2 * 60 * 60 * 1000);
    await expect(
      mod.joinByInvite(outsider.user.id, { inviteToken: expInvite.inviteToken }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Member cannot change outsider's role; HOST_ADMIN can
    await expect(
      mod.updateMemberRole(memberClaims, group.id, member.user.id, { role: 'ADMIN' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Non-admin cannot delete invite (403); missing invite returns 404; admin can delete
    await expect(mod.deleteInvite(memberClaims, expInvite.inviteToken)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(mod.deleteInvite(adminClaims, 'inv_missing')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(mod.deleteInvite(adminClaims, expInvite.inviteToken)).resolves.toEqual({
      deleted: true,
      token: expInvite.inviteToken,
    });
    await expect(mod.previewInvite(expInvite.inviteToken)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('falls back to LAN Origin when PUBLIC_SERVER_URL is localhost', async () => {
    const { mod } = createTestHarness('http://localhost:8080');
    const admin = await mod.register({
      email: 'lan@example.com',
      username: 'LanHost',
      password: 'Password1234',
    });
    const group = await mod.createGroup(admin.user.id, { name: 'LAN Group' });
    const invite = await mod.createInvite(
      {
        id: admin.user.id,
        email: admin.user.email,
        username: admin.user.username,
        role: 'HOST_ADMIN',
      },
      { groupId: group.id, assignedRole: 'MEMBER', maxUses: 2, expiresInHours: 2 },
      'http://192.168.1.50:8080',
    );
    expect(invite.serverUrl).toBe('http://192.168.1.50:8080');
  });

  it('issues, rotates, and revokes scoped tracker tokens with OwnTracks and Overland URLs', async () => {
    const { mod, tokenService } = createTestHarness('https://track.example.com');
    const reg = await mod.register({
      email: 'tracker@example.com',
      username: 'TrackerUser',
      password: 'Password1234',
    });

    const userClaims = {
      id: reg.user.id,
      email: reg.user.email,
      username: reg.user.username,
      role: reg.user.role,
    };

    expect(await mod.getTrackerTokenStatus(reg.user.id)).toEqual({
      active: false,
      ttlSeconds: 0,
    });

    const created = await mod.createTrackerToken(userClaims, { expiresInDays: 30 });
    expect(created.expiresInDays).toBe(30);
    expect(created.owntracksUrl).toBe(
      `https://track.example.com/api/realtime/owntracks?token=${created.token}`,
    );
    expect(created.overlandUrl).toBe(
      `https://track.example.com/api/realtime/overland?token=${created.token}`,
    );

    const verified = await tokenService.verifyIngestionToken(created.token);
    expect(verified.type).toBe('tracker');
    await expect(tokenService.verifyAccessToken(created.token)).rejects.toThrow();

    expect(await mod.getTrackerTokenStatus(reg.user.id)).toEqual({
      active: true,
      ttlSeconds: 30 * 86400,
    });

    await mod.revokeTrackerToken(reg.user.id);
    expect(await mod.getTrackerTokenStatus(reg.user.id)).toEqual({
      active: false,
      ttlSeconds: 0,
    });
  });

  it('updates username, email, avatarUrl, and password while enforcing email uniqueness and current password check', async () => {
    const { mod, sessionStore } = createTestHarness();
    const published: Array<{ userId: string; username: string; avatarUrl: string | null }> = [];
    sessionStore.publishProfileUpdated = async (evt) => {
      published.push({ userId: evt.userId, username: evt.username, avatarUrl: evt.avatarUrl });
    };

    const a = await mod.register({
      email: 'alice@example.com',
      username: 'Alice',
      password: 'Password123',
    });
    await mod.register({
      email: 'bob@example.com',
      username: 'Bob',
      password: 'Password123',
    });

    await expect(
      mod.updateProfile(a.user.id, { email: 'BOB@example.com' }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const dataPng = 'data:image/png;base64,iVBORw0KGgo=';
    const updated = await mod.updateProfile(a.user.id, {
      username: 'Alice Updated',
      email: 'alice2@example.com',
      avatarUrl: dataPng,
    });
    expect(updated.user.username).toBe('Alice Updated');
    expect(updated.user.email).toBe('alice2@example.com');
    expect(updated.user.avatarUrl).toBe(dataPng);
    expect(published).toEqual([
      { userId: a.user.id, username: 'Alice Updated', avatarUrl: dataPng },
    ]);

    const cleared = await mod.updateProfile(a.user.id, { avatarUrl: null });
    expect(cleared.user.avatarUrl).toBeNull();

    await expect(
      mod.changePassword(a.user.id, {
        currentPassword: 'WrongPassword',
        newPassword: 'NewPassword456',
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      mod.changePassword(a.user.id, {
        currentPassword: 'Password123',
        newPassword: 'NewPassword456',
      }),
    ).resolves.toEqual({ updated: true });

    const relogin = await mod.login({
      email: 'alice2@example.com',
      password: 'NewPassword456',
    });
    expect(relogin.user.username).toBe('Alice Updated');
  });

  it('verifies backup recovery email via 6-digit code and resets forgotten passwords only when verified', async () => {
    const store = createInMemoryAuthGroupStore();
    const sentMail: Array<{ to: string; subject: string; text: string }> = [];
    let currentTime = Date.parse('2026-11-20T12:00:00Z');

    const mod = new AuthGroupModule({
      store,
      sessionStore: { saveSession: async () => {} },
      tokenService: createTokenService({
        jwtSecret: 'test-access-secret-with-at-least-32-chars',
        jwtRefreshSecret: 'test-refresh-secret-with-at-least-32-chars',
      }),
      emailSender: {
        isConfigured: () => true,
        async sendMail(msg) {
          sentMail.push(msg);
        },
      },
      now: () => currentTime,
    });

    const user = await mod.register({
      email: 'alice@example.com',
      username: 'Alice',
      password: 'OriginalPassword1',
    });
    expect(user.user.recoveryEmail).toBeNull();
    expect(user.user.recoveryEmailVerified).toBe(false);

    // Forgot password before verification must NOT send any email
    await mod.requestPasswordReset({ email: 'alice@example.com' });
    expect(sentMail).toHaveLength(0);

    // Request verification code for backup email
    const sendRes = await mod.sendRecoveryVerificationCode(user.user.id, {
      recoveryEmail: 'alice.backup@gmail.com',
    });
    expect(sendRes.sent).toBe(true);
    expect(sendRes.recoveryEmail).toBe('alice.backup@gmail.com');
    expect(sentMail).toHaveLength(1);
    const verifyCode = sentMail[0].text.match(/\b(\d{6})\b/)?.[1];
    expect(verifyCode).toBeTruthy();

    // Wrong verification code fails cleanly
    await expect(
      mod.verifyRecoveryEmail(user.user.id, {
        recoveryEmail: 'alice.backup@gmail.com',
        code: verifyCode === '000000' ? '000001' : '000000',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Correct verification code marks recoveryEmailVerified = true
    const verified = await mod.verifyRecoveryEmail(user.user.id, {
      recoveryEmail: 'alice.backup@gmail.com',
      code: verifyCode!,
    });
    expect(verified.verified).toBe(true);
    expect(verified.user.recoveryEmail).toBe('alice.backup@gmail.com');
    expect(verified.user.recoveryEmailVerified).toBe(true);

    // Advance past 30s cooldown, request password reset using the backup email
    currentTime += 35_000;
    const reqReset = await mod.requestPasswordReset({ email: 'alice.backup@gmail.com' });
    expect(reqReset.ok).toBe(true);
    expect(sentMail).toHaveLength(2);
    expect(sentMail[1].to).toBe('alice.backup@gmail.com');
    const resetCode = sentMail[1].text.match(/\b(\d{6})\b/)?.[1];
    expect(resetCode).toBeTruthy();

    // Complete password reset using account login email + reset code
    const doneReset = await mod.resetPasswordWithCode({
      email: 'alice@example.com',
      code: resetCode!,
      newPassword: 'RecoveredPassword2',
    });
    expect(doneReset).toEqual({ reset: true });

    // Old password rejected, new password works
    await expect(
      mod.login({ email: 'alice@example.com', password: 'OriginalPassword1' }),
    ).rejects.toMatchObject({ statusCode: 401 });

    const signedIn = await mod.login({
      email: 'alice@example.com',
      password: 'RecoveredPassword2',
    });
    expect(signedIn.user.recoveryEmailVerified).toBe(true);

    // Clearing backup email disables password recovery again
    const cleared = await mod.clearRecoveryEmail(user.user.id);
    expect(cleared.cleared).toBe(true);
    expect(cleared.user.recoveryEmail).toBeNull();
    expect(cleared.user.recoveryEmailVerified).toBe(false);
  });
});

describe('TelemetryQueryModule domain interface', () => {
  it('computes storage alert thresholds and sorts accounts by cpuMsPerMin', async () => {
    const store: TelemetryQueryStore = {
      async computeLogStorageBytes() {
        return 85 * 1024 * 1024;
      },
      async getDatabaseTelemetry() {
        return {
          databaseBytes: 12_000_000,
          users: [
            {
              userId: '11111111-1111-4111-8111-111111111111',
              username: 'LowCpu',
              email: 'low@example.com',
              role: 'USER',
              locationBytes: 100,
              locationPoints: 2,
            },
            {
              userId: '22222222-2222-4222-8222-222222222222',
              username: 'HighCpu',
              email: 'high@example.com',
              role: 'HOST_ADMIN',
              locationBytes: 400,
              locationPoints: 8,
            },
          ],
        };
      },
      async getUserTelemetry(userId) {
        if (userId.startsWith('2')) {
          return {
            cpuMsTotal: 500,
            cpuMsPerMin: 120,
            eventsCount: 40,
            pingsPerMin: 10,
            activeSockets: 2,
            redisMemoryBytes: 2048,
          };
        }
        return {
          cpuMsTotal: 50,
          cpuMsPerMin: 5,
          eventsCount: 4,
          pingsPerMin: 1,
          activeSockets: 0,
          redisMemoryBytes: 512,
        };
      },
      async getRecentLogLines() {
        return ['line-2', 'line-1'];
      },
    };

    const mod = new TelemetryQueryModule({
      store,
      logDir: '/var/log/app',
      maxLogStorageMb: 100,
      now: () => new Date('2026-11-17T12:00:00Z'),
    });

    const snapshot = await mod.getSystemTelemetry();
    expect(snapshot.logStoragePercent).toBe(85);
    expect(snapshot.logStorageAlert).toBe(true);
    expect(snapshot.totalLocationPoints).toBe(10);
    expect(snapshot.totalActiveSockets).toBe(2);
    expect(snapshot.users.map((u) => u.username)).toEqual(['HighCpu', 'LowCpu']);

    const logs = await mod.getRecentLogs(2);
    expect(logs.logs).toEqual(['line-1', 'line-2']);
  });
});
