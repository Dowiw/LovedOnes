import crypto from 'node:crypto';
import argon2 from 'argon2';
import {
  ChangePasswordSchema,
  CreateGroupSchema,
  CreateInviteSchema,
  CreateTrackerTokenSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResetSchema,
  GroupRole,
  JoinInviteSchema,
  JwtUserPayload,
  LoginSchema,
  normalizePrivacyMode,
  PrivacyMode,
  QrInvitePayload,
  QrInvitePayloadSchema,
  RecoveryEmailSendCodeSchema,
  RecoveryEmailVerifySchema,
  RefreshSchema,
  RegisterSchema,
  SystemRole,
  UpdateMemberRoleSchema,
  UpdatePrivacySchema,
  UpdateProfileSchema,
} from '@loved-ones/shared';
import { DomainError, TokenPair, TokenService } from '@loved-ones/shared/auth';

export interface AccountRecord {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  role: SystemRole;
  avatarUrl: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  recoveryEmail: string | null;
  recoveryEmailVerified: boolean;
  createdAt: Date;
}

export type PublicAccountRecord = Omit<AccountRecord, 'passwordHash'>;

export interface GroupSummaryRecord {
  id: string;
  name: string;
  createdAt: Date;
}

export interface MembershipSummaryRecord {
  groupId: string;
  name: string;
  role: GroupRole;
  privacy: PrivacyMode;
  joinedAt: Date;
}

export interface GroupMemberEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  joinedAt: string;
}

export interface GroupWithMembers {
  id: string;
  name: string;
  createdAt: string;
  myRole: GroupRole;
  myPrivacy: PrivacyMode;
  members: GroupMemberEntry[];
}

export interface InviteRecord {
  token: string;
  groupId: string;
  groupName: string;
  assignedRole: GroupRole;
  maxUses: number;
  uses: number;
  expiresAt: Date;
}

export interface AuthGroupTxStore {
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  countAccounts(): Promise<number>;
  insertAccount(input: {
    email: string;
    username: string;
    passwordHash: string;
    role: SystemRole;
  }): Promise<PublicAccountRecord>;
  findInviteForUpdate(token: string): Promise<InviteRecord | null>;
  findMembership(
    userId: string,
    groupId: string,
  ): Promise<{ role: GroupRole; privacy: PrivacyMode } | null>;
  insertMembership(input: {
    userId: string;
    groupId: string;
    role: GroupRole;
    privacy: PrivacyMode;
  }): Promise<void>;
  incrementInviteUses(token: string): Promise<void>;
  insertGroup(name: string, createdBy: string): Promise<GroupSummaryRecord>;
}

export interface AuthGroupStore {
  withTransaction<T>(
    fn: (tx: AuthGroupTxStore) => Promise<T>,
    options?: { registrationLock?: boolean },
  ): Promise<T>;
  findAccountByEmail(email: string): Promise<AccountRecord | null>;
  findAccountByVerifiedRecoveryEmail?(recoveryEmail: string): Promise<AccountRecord | null>;
  findAccountById(id: string): Promise<PublicAccountRecord | null>;
  findAccountWithPasswordById?(id: string): Promise<AccountRecord | null>;
  updateAccountProfile?(
    userId: string,
    patch: {
      email?: string;
      username?: string;
      avatarUrl?: string | null;
      haloColor?: string | null;
      fuzzCircleColor?: string | null;
    },
  ): Promise<{ status: 'ok'; account: PublicAccountRecord } | { status: 'email_conflict' } | { status: 'not_found' }>;
  updateRecoveryEmail?(
    userId: string,
    recoveryEmail: string | null,
    verified: boolean,
  ): Promise<PublicAccountRecord | null>;
  updateAccountPassword?(userId: string, passwordHash: string): Promise<boolean>;
  listAccountMemberships(userId: string): Promise<MembershipSummaryRecord[]>;
  listGroupsWithMembers(userId: string): Promise<GroupWithMembers[]>;
  findInviteByToken(token: string): Promise<InviteRecord | null>;
  findGroupById(groupId: string): Promise<{ id: string; name: string } | null>;
  findMembership(
    userId: string,
    groupId: string,
  ): Promise<{ role: GroupRole; privacy: PrivacyMode } | null>;
  hasAnyAdminMembership(userId: string): Promise<boolean>;
  updateMembershipPrivacy(
    userId: string,
    groupId: string,
    privacy: PrivacyMode,
  ): Promise<PrivacyMode | null>;
  updateMembershipRole(
    userId: string,
    groupId: string,
    role: GroupRole,
  ): Promise<{ userId: string; role: GroupRole } | null>;
  insertInvite(input: {
    token: string;
    groupId: string;
    assignedRole: GroupRole;
    createdBy: string;
    maxUses: number;
    expiresAt: Date;
  }): Promise<void>;
  listInvites(caller: { userId: string; systemRole: SystemRole }): Promise<InviteRecord[]>;
  deleteInvite?(token: string): Promise<boolean>;
  deleteAccountById?(userId: string): Promise<PublicAccountRecord | null>;
}

export interface EmailChallengeRecord {
  salt: string;
  codeHash: string;
  targetEmail: string;
  createdAtMs: number;
  attempts: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  isConfigured(): boolean;
  sendMail(msg: EmailMessage): Promise<void>;
}

export interface SessionStore {
  saveSession(account: {
    id: string;
    email: string;
    username: string;
    role: SystemRole;
  }): Promise<void>;
  saveTrackerTokenJti?(userId: string, jti: string, expiresInDays: number): Promise<void>;
  revokeTrackerTokenJti?(userId: string): Promise<void>;
  getTrackerTokenStatus?(userId: string): Promise<{ active: boolean; ttlSeconds: number }>;
  publishProfileUpdated?(event: {
    userId: string;
    username: string;
    avatarUrl: string | null;
    haloColor?: string | null;
    fuzzCircleColor?: string | null;
    groupIds: string[];
  }): Promise<void>;
  saveEmailChallenge?(
    key: string,
    record: EmailChallengeRecord,
    ttlSeconds: number,
  ): Promise<void>;
  getEmailChallenge?(key: string): Promise<EmailChallengeRecord | null>;
  deleteEmailChallenge?(key: string): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AuthGroupModuleOptions {
  store: AuthGroupStore;
  sessionStore: SessionStore;
  tokenService: TokenService;
  emailSender?: EmailSender;
  publicServerUrl?: string;
  passwordHasher?: PasswordHasher;
  now?: () => number;
}

const defaultPasswordHasher: PasswordHasher = {
  hash(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
  },
  verify(hash: string, password: string) {
    return argon2.verify(hash, password);
  },
};

function isLocalhostUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1'
    );
  } catch {
    return false;
  }
}

export interface AuthSuccessResult extends TokenPair {
  user: {
    id: string;
    email: string;
    username: string;
    role: SystemRole;
    avatarUrl: string | null;
    haloColor: string | null;
    fuzzCircleColor: string | null;
    recoveryEmail: string | null;
    recoveryEmailVerified: boolean;
    createdAt: string;
  };
}

export interface RegisterResult extends AuthSuccessResult {
  joinedGroup: { groupId: string; groupName: string; role: GroupRole } | null;
}

export interface CreatedInviteResult extends QrInvitePayload {
  joinUrl: string;
  assignedRole: GroupRole;
  maxUses: number;
  expiresAt: string;
}

export interface CreatedTrackerTokenResult {
  token: string;
  expiresInDays: number;
  expiresAt: string;
  serverUrl: string;
  owntracksUrl: string;
  overlandUrl: string;
}

/**
 * Deep domain module owning account registration, authentication, token refresh,
 * group creation, membership RBAC, and invite issuance/redemption.
 */
export class AuthGroupModule {
  private readonly store: AuthGroupStore;
  private readonly sessionStore: SessionStore;
  private readonly tokenService: TokenService;
  private readonly emailSender?: EmailSender;
  private readonly publicServerUrl: string;
  private readonly passwordHasher: PasswordHasher;
  private readonly now: () => number;
  private readonly fallbackChallenges = new Map<
    string,
    { record: EmailChallengeRecord; expiresAtMs: number }
  >();

  constructor(options: AuthGroupModuleOptions) {
    this.store = options.store;
    this.sessionStore = options.sessionStore;
    this.tokenService = options.tokenService;
    this.emailSender = options.emailSender;
    this.publicServerUrl = options.publicServerUrl ?? 'http://localhost:8080';
    this.passwordHasher = options.passwordHasher ?? defaultPasswordHasher;
    this.now = options.now ?? (() => Date.now());
  }

  private formatPublicUser(account: PublicAccountRecord): AuthSuccessResult['user'] {
    return {
      id: account.id,
      email: account.email,
      username: account.username,
      role: account.role,
      avatarUrl: account.avatarUrl,
      haloColor: account.haloColor ?? null,
      fuzzCircleColor: account.fuzzCircleColor ?? null,
      recoveryEmail: account.recoveryEmail ?? null,
      recoveryEmailVerified: Boolean(account.recoveryEmailVerified),
      createdAt: account.createdAt.toISOString(),
    };
  }

  private hashEmailCode(
    purpose: 'verify' | 'reset',
    salt: string,
    userId: string,
    targetEmail: string,
    code: string,
  ): string {
    return crypto
      .createHash('sha256')
      .update(`${salt}:${purpose}:${userId}:${targetEmail.toLowerCase()}:${code}`)
      .digest('hex');
  }

  private async saveChallenge(
    key: string,
    record: EmailChallengeRecord,
    ttlSeconds: number,
  ): Promise<void> {
    if (this.sessionStore.saveEmailChallenge) {
      await this.sessionStore.saveEmailChallenge(key, record, ttlSeconds);
      return;
    }
    this.fallbackChallenges.set(key, {
      record,
      expiresAtMs: this.now() + ttlSeconds * 1000,
    });
  }

  private async getChallenge(key: string): Promise<EmailChallengeRecord | null> {
    if (this.sessionStore.getEmailChallenge) {
      return this.sessionStore.getEmailChallenge(key);
    }
    const entry = this.fallbackChallenges.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.fallbackChallenges.delete(key);
      return null;
    }
    return entry.record;
  }

  private async deleteChallenge(key: string): Promise<void> {
    if (this.sessionStore.deleteEmailChallenge) {
      await this.sessionStore.deleteEmailChallenge(key);
      return;
    }
    this.fallbackChallenges.delete(key);
  }

  private async findRecoveryAccount(identifierEmail: string): Promise<AccountRecord | null> {
    const clean = identifierEmail.trim().toLowerCase();
    const byPrimary = await this.store.findAccountByEmail(clean);
    if (byPrimary) {
      return byPrimary;
    }
    if (this.store.findAccountByVerifiedRecoveryEmail) {
      return this.store.findAccountByVerifiedRecoveryEmail(clean);
    }
    return null;
  }

  private async issueAndPersistSession(account: PublicAccountRecord): Promise<TokenPair> {
    const tokens = await this.tokenService.issueTokenPair(account);
    await this.sessionStore.saveSession(account);
    return tokens;
  }

  private resolveInviteServerUrl(requestOrigin?: string): string {
    if (this.publicServerUrl && !isLocalhostUrl(this.publicServerUrl)) {
      return this.publicServerUrl;
    }
    if (requestOrigin && requestOrigin !== 'null') {
      return requestOrigin;
    }
    return this.publicServerUrl;
  }

  async register(rawInput: unknown): Promise<RegisterResult> {
    const parsed = RegisterSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid input', parsed.error.flatten());
    }
    const { email, username, password, inviteToken } = parsed.data;
    const passwordHash = await this.passwordHasher.hash(password);

    const { createdUser, joinedGroup } = await this.store.withTransaction(
      async (tx) => {
        const existing = await tx.findAccountByEmail(email);
        if (existing) {
          throw new DomainError(409, 'Email already registered');
        }

        const existingCount = await tx.countAccounts();
        const assignedSystemRole: SystemRole = existingCount === 0 ? 'HOST_ADMIN' : 'USER';

        const account = await tx.insertAccount({
          email: email.toLowerCase(),
          username,
          passwordHash,
          role: assignedSystemRole,
        });

        let joined: { groupId: string; groupName: string; role: GroupRole } | null = null;
        if (inviteToken) {
          const inv = await tx.findInviteForUpdate(inviteToken);
          if (!inv || inv.uses >= inv.maxUses || inv.expiresAt.getTime() <= this.now()) {
            throw new DomainError(400, 'Invalid or expired invite token');
          }

          await tx.insertMembership({
            userId: account.id,
            groupId: inv.groupId,
            role: inv.assignedRole,
            privacy: 'EXACT',
          });
          await tx.incrementInviteUses(inviteToken);
          joined = {
            groupId: inv.groupId,
            groupName: inv.groupName,
            role: inv.assignedRole,
          };
        }

        return { createdUser: account, joinedGroup: joined };
      },
      { registrationLock: true },
    );

    const tokens = await this.issueAndPersistSession(createdUser);
    return {
      ...tokens,
      user: this.formatPublicUser(createdUser),
      joinedGroup,
    };
  }

  async login(rawInput: unknown): Promise<AuthSuccessResult> {
    const parsed = LoginSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid input', parsed.error.flatten());
    }
    const { email, password } = parsed.data;
    const account = await this.store.findAccountByEmail(email);
    if (!account) {
      throw new DomainError(401, 'Invalid email or password');
    }
    const valid = await this.passwordHasher.verify(account.passwordHash, password);
    if (!valid) {
      throw new DomainError(401, 'Invalid email or password');
    }

    const tokens = await this.issueAndPersistSession(account);
    return {
      ...tokens,
      user: this.formatPublicUser(account),
    };
  }

  async refresh(rawInput: unknown): Promise<{ tokens: TokenPair; userId: string }> {
    const parsed = RefreshSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid refresh token payload');
    }
    let payload: JwtUserPayload;
    try {
      payload = await this.tokenService.verifyRefreshToken(parsed.data.refreshToken);
    } catch {
      throw new DomainError(401, 'Invalid or expired refresh token');
    }

    const account = await this.store.findAccountById(payload.id);
    if (!account) {
      throw new DomainError(401, 'Your account was removed from this server.', {
        code: 'ACCOUNT_REMOVED',
      });
    }

    const tokens = await this.issueAndPersistSession(account);
    return { tokens, userId: account.id };
  }

  async getMe(userId: string) {
    const [account, memberships] = await Promise.all([
      this.store.findAccountById(userId),
      this.store.listAccountMemberships(userId),
    ]);
    if (!account) {
      throw new DomainError(401, 'Your account was removed from this server.', {
        code: 'ACCOUNT_REMOVED',
      });
    }

    return {
      user: this.formatPublicUser(account),
      groups: memberships.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        role: g.role,
        privacy: g.privacy,
        joinedAt: g.joinedAt.toISOString(),
      })),
    };
  }

  async updateProfile(userId: string, rawInput: unknown): Promise<AuthSuccessResult> {
    const parsed = UpdateProfileSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid profile update payload', parsed.error.flatten());
    }
    if (!this.store.updateAccountProfile) {
      throw new DomainError(501, 'Profile updates not supported by store');
    }

    const patch: {
      email?: string;
      username?: string;
      avatarUrl?: string | null;
      haloColor?: string | null;
      fuzzCircleColor?: string | null;
    } = {};
    if (parsed.data.username !== undefined) patch.username = parsed.data.username;
    if (parsed.data.email !== undefined) patch.email = parsed.data.email.toLowerCase();
    if (parsed.data.avatarUrl !== undefined) patch.avatarUrl = parsed.data.avatarUrl;
    if (parsed.data.haloColor !== undefined) patch.haloColor = parsed.data.haloColor;
    if (parsed.data.fuzzCircleColor !== undefined) patch.fuzzCircleColor = parsed.data.fuzzCircleColor;

    const res = await this.store.updateAccountProfile(userId, patch);
    if (res.status === 'not_found') {
      throw new DomainError(404, 'User not found');
    }
    if (res.status === 'email_conflict') {
      throw new DomainError(409, 'Email already registered');
    }

    const updated = res.account;
    const [tokens, memberships] = await Promise.all([
      this.issueAndPersistSession(updated),
      this.store.listAccountMemberships(userId),
    ]);

    if (this.sessionStore.publishProfileUpdated) {
      await this.sessionStore
        .publishProfileUpdated({
          userId: updated.id,
          username: updated.username,
          avatarUrl: updated.avatarUrl,
          haloColor: updated.haloColor ?? null,
          fuzzCircleColor: updated.fuzzCircleColor ?? null,
          groupIds: memberships.map((m) => m.groupId),
        })
        .catch(() => {});
    }

    return {
      ...tokens,
      user: this.formatPublicUser(updated),
    };
  }

  async changePassword(userId: string, rawInput: unknown): Promise<{ updated: true }> {
    const parsed = ChangePasswordSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid password change payload', parsed.error.flatten());
    }
    if (!this.store.findAccountWithPasswordById || !this.store.updateAccountPassword) {
      throw new DomainError(501, 'Password updates not supported by store');
    }

    const account = await this.store.findAccountWithPasswordById(userId);
    if (!account) {
      throw new DomainError(404, 'User not found');
    }
    const valid = await this.passwordHasher.verify(account.passwordHash, parsed.data.currentPassword);
    if (!valid) {
      throw new DomainError(401, 'Current password is incorrect');
    }

    const nextHash = await this.passwordHasher.hash(parsed.data.newPassword);
    await this.store.updateAccountPassword(userId, nextHash);
    return { updated: true };
  }

  private async verifyChallengeCode(
    key: string,
    purpose: 'verify' | 'reset',
    userId: string,
    targetEmail: string,
    code: string,
  ): Promise<void> {
    const challenge = await this.getChallenge(key);
    if (!challenge || challenge.targetEmail !== targetEmail.toLowerCase()) {
      throw new DomainError(400, 'Verification code expired or not requested');
    }

    const candidateHash = this.hashEmailCode(
      purpose,
      challenge.salt,
      userId,
      targetEmail,
      code,
    );
    const a = Buffer.from(candidateHash, 'hex');
    const b = Buffer.from(challenge.codeHash, 'hex');
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!match) {
      const nextAttempts = challenge.attempts + 1;
      if (nextAttempts >= 5) {
        await this.deleteChallenge(key);
        throw new DomainError(429, 'Too many invalid attempts. Please request a new code.');
      }
      const elapsedSec = Math.floor((this.now() - challenge.createdAtMs) / 1000);
      const remainingSec = Math.max(60, 900 - Math.max(0, elapsedSec));
      await this.saveChallenge(key, { ...challenge, attempts: nextAttempts }, remainingSec);
      throw new DomainError(400, 'Invalid verification code');
    }

    await this.deleteChallenge(key);
  }

  async sendRecoveryVerificationCode(
    userId: string,
    rawInput: unknown,
  ): Promise<{ sent: true; recoveryEmail: string; expiresInSeconds: number; user: AuthSuccessResult['user'] }> {
    const parsed = RecoveryEmailSendCodeSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Enter a valid backup email address', parsed.error.flatten());
    }
    if (!this.store.updateRecoveryEmail) {
      throw new DomainError(501, 'Recovery email is not supported by store');
    }
    if (!this.emailSender?.isConfigured()) {
      throw new DomainError(
        503,
        'Email delivery is not configured on the server (set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM).',
      );
    }

    const account = await this.store.findAccountById(userId);
    if (!account) {
      throw new DomainError(404, 'User not found');
    }

    const targetEmail = parsed.data.recoveryEmail.toLowerCase();
    const challengeKey = `verify:${userId}`;
    const existing = await this.getChallenge(challengeKey);
    if (existing && this.now() - existing.createdAtMs < 30_000) {
      throw new DomainError(429, 'Please wait 30 seconds before requesting another code');
    }

    const keepVerified =
      account.recoveryEmail?.toLowerCase() === targetEmail && account.recoveryEmailVerified;
    const saved = keepVerified
      ? account
      : await this.store.updateRecoveryEmail(userId, targetEmail, false);
    if (!saved) {
      throw new DomainError(404, 'User not found');
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = this.hashEmailCode('verify', salt, userId, targetEmail, code);

    await this.saveChallenge(
      challengeKey,
      {
        salt,
        codeHash,
        targetEmail,
        createdAtMs: this.now(),
        attempts: 0,
      },
      900,
    );

    try {
      await this.emailSender.sendMail({
        to: targetEmail,
        subject: 'LovedOnes — Verify your backup email',
        text: `Hi ${saved.username},\n\nYour LovedOnes backup email verification code is: ${code}\n\nThis code expires in 15 minutes. Once verified, you can use this email to recover a forgotten password.`,
      });
    } catch (err) {
      await this.deleteChallenge(challengeKey);
      const reason = err instanceof Error ? err.message : 'SMTP delivery failed';
      throw new DomainError(502, `Could not send verification email: ${reason}`);
    }

    return {
      sent: true,
      recoveryEmail: targetEmail,
      expiresInSeconds: 900,
      user: this.formatPublicUser(saved),
    };
  }

  async verifyRecoveryEmail(
    userId: string,
    rawInput: unknown,
  ): Promise<{ verified: true; user: AuthSuccessResult['user'] }> {
    const parsed = RecoveryEmailVerifySchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Enter a valid email and 6-digit code', parsed.error.flatten());
    }
    if (!this.store.updateRecoveryEmail) {
      throw new DomainError(501, 'Recovery email is not supported by store');
    }

    const targetEmail = parsed.data.recoveryEmail.toLowerCase();
    await this.verifyChallengeCode(`verify:${userId}`, 'verify', userId, targetEmail, parsed.data.code);

    const updated = await this.store.updateRecoveryEmail(userId, targetEmail, true);
    if (!updated) {
      throw new DomainError(404, 'User not found');
    }
    await this.sessionStore.saveSession(updated);

    return {
      verified: true,
      user: this.formatPublicUser(updated),
    };
  }

  async clearRecoveryEmail(userId: string): Promise<{ cleared: true; user: AuthSuccessResult['user'] }> {
    if (!this.store.updateRecoveryEmail) {
      throw new DomainError(501, 'Recovery email is not supported by store');
    }
    await this.deleteChallenge(`verify:${userId}`);
    const updated = await this.store.updateRecoveryEmail(userId, null, false);
    if (!updated) {
      throw new DomainError(404, 'User not found');
    }
    await this.sessionStore.saveSession(updated);
    return {
      cleared: true,
      user: this.formatPublicUser(updated),
    };
  }

  async requestPasswordReset(
    rawInput: unknown,
  ): Promise<{ ok: true; message: string }> {
    const parsed = ForgotPasswordRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Enter a valid email address', parsed.error.flatten());
    }

    const genericMessage =
      'If that account has a verified backup email, a 6-digit reset code has been sent.';
    const lookupEmail = parsed.data.email.toLowerCase();
    const account = await this.findRecoveryAccount(lookupEmail);

    if (
      !account ||
      !account.recoveryEmail ||
      !account.recoveryEmailVerified ||
      !this.emailSender?.isConfigured()
    ) {
      return { ok: true, message: genericMessage };
    }

    const challengeKey = `reset:${account.id}`;
    const existing = await this.getChallenge(challengeKey);
    if (existing && this.now() - existing.createdAtMs < 30_000) {
      return { ok: true, message: genericMessage };
    }

    const targetEmail = account.recoveryEmail.toLowerCase();
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = this.hashEmailCode('reset', salt, account.id, targetEmail, code);

    await this.saveChallenge(
      challengeKey,
      {
        salt,
        codeHash,
        targetEmail,
        createdAtMs: this.now(),
        attempts: 0,
      },
      900,
    );

    try {
      await this.emailSender.sendMail({
        to: targetEmail,
        subject: 'LovedOnes — Password reset code',
        text: `Hi ${account.username},\n\nYour LovedOnes password reset code is: ${code}\n\nThis code expires in 15 minutes. If you did not request a password reset, you can ignore this email.`,
      });
    } catch {
      await this.deleteChallenge(challengeKey);
    }

    return { ok: true, message: genericMessage };
  }

  async resetPasswordWithCode(rawInput: unknown): Promise<{ reset: true }> {
    const parsed = ForgotPasswordResetSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Enter a valid email, 6-digit code, and 8+ character password', parsed.error.flatten());
    }
    if (!this.store.updateAccountPassword) {
      throw new DomainError(501, 'Password updates not supported by store');
    }

    const lookupEmail = parsed.data.email.toLowerCase();
    const account = await this.findRecoveryAccount(lookupEmail);
    if (!account || !account.recoveryEmail || !account.recoveryEmailVerified) {
      throw new DomainError(400, 'Invalid or expired reset code');
    }

    await this.verifyChallengeCode(
      `reset:${account.id}`,
      'reset',
      account.id,
      account.recoveryEmail.toLowerCase(),
      parsed.data.code,
    );

    const nextHash = await this.passwordHasher.hash(parsed.data.newPassword);
    await this.store.updateAccountPassword(account.id, nextHash);
    return { reset: true };
  }

  async previewInvite(token: string) {
    const inv = await this.store.findInviteByToken(token);
    if (!inv) {
      throw new DomainError(404, 'Invite not found');
    }
    const valid = inv.uses < inv.maxUses && inv.expiresAt.getTime() > this.now();
    return {
      token: inv.token,
      groupId: inv.groupId,
      groupName: inv.groupName,
      assignedRole: inv.assignedRole,
      maxUses: inv.maxUses,
      uses: inv.uses,
      expiresAt: inv.expiresAt.toISOString(),
      valid,
    };
  }

  async joinByInvite(userId: string, rawInput: unknown) {
    const parsed = JoinInviteSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid invite payload');
    }
    const { inviteToken } = parsed.data;

    return this.store.withTransaction(async (tx) => {
      const inv = await tx.findInviteForUpdate(inviteToken);
      if (!inv || inv.uses >= inv.maxUses || inv.expiresAt.getTime() <= this.now()) {
        throw new DomainError(400, 'Invalid or expired invite token');
      }

      const existing = await tx.findMembership(userId, inv.groupId);
      if (existing) {
        return {
          groupId: inv.groupId,
          groupName: inv.groupName,
          role: existing.role,
          privacy: existing.privacy,
          alreadyMember: true,
        };
      }

      await tx.insertMembership({
        userId,
        groupId: inv.groupId,
        role: inv.assignedRole,
        privacy: 'EXACT',
      });
      await tx.incrementInviteUses(inviteToken);

      return {
        groupId: inv.groupId,
        groupName: inv.groupName,
        role: inv.assignedRole,
        privacy: 'EXACT' as PrivacyMode,
        alreadyMember: false,
      };
    });
  }

  async listGroups(userId: string): Promise<{ groups: GroupWithMembers[] }> {
    const groups = await this.store.listGroupsWithMembers(userId);
    return { groups };
  }

  async createGroup(userId: string, rawInput: unknown) {
    const parsed = CreateGroupSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid group payload');
    }
    const group = await this.store.withTransaction(async (tx) => {
      const created = await tx.insertGroup(parsed.data.name, userId);
      await tx.insertMembership({
        userId,
        groupId: created.id,
        role: 'ADMIN',
        privacy: 'EXACT',
      });
      return created;
    });

    return {
      id: group.id,
      name: group.name,
      createdAt: group.createdAt.toISOString(),
      myRole: 'ADMIN' as GroupRole,
      myPrivacy: 'EXACT' as PrivacyMode,
    };
  }

  async updatePrivacy(userId: string, groupId: string, rawInput: unknown) {
    const parsed = UpdatePrivacySchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid privacy mode');
    }
    const normalized = normalizePrivacyMode(parsed.data.privacy);
    const updated = await this.store.updateMembershipPrivacy(userId, groupId, normalized);
    if (!updated) {
      throw new DomainError(404, 'Membership not found');
    }
    return { groupId, privacy: updated };
  }

  async updateMemberRole(
    caller: JwtUserPayload,
    groupId: string,
    targetUserId: string,
    rawInput: unknown,
  ) {
    const parsed = UpdateMemberRoleSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid role payload');
    }
    if (caller.role !== 'HOST_ADMIN') {
      const membership = await this.store.findMembership(caller.id, groupId);
      if (membership?.role !== 'ADMIN') {
        throw new DomainError(403, 'Group ADMIN role required');
      }
    }

    const updated = await this.store.updateMembershipRole(
      targetUserId,
      groupId,
      parsed.data.role,
    );
    if (!updated) {
      throw new DomainError(404, 'Target membership not found');
    }
    return { groupId, userId: updated.userId, role: updated.role };
  }

  async assertAdmin(caller: JwtUserPayload): Promise<void> {
    if (caller.role === 'HOST_ADMIN') {
      return;
    }
    const isAdmin = await this.store.hasAnyAdminMembership(caller.id);
    if (!isAdmin) {
      throw new DomainError(403, 'Admin privileges required');
    }
  }

  async createInvite(
    caller: JwtUserPayload,
    rawInput: unknown,
    requestOrigin?: string,
  ): Promise<CreatedInviteResult> {
    const parsed = CreateInviteSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid invite payload', parsed.error.flatten());
    }
    const { groupId, assignedRole, maxUses, expiresInHours } = parsed.data;

    const group = await this.store.findGroupById(groupId);
    if (!group) {
      throw new DomainError(404, 'Group not found');
    }

    if (caller.role !== 'HOST_ADMIN') {
      const membership = await this.store.findMembership(caller.id, groupId);
      if (membership?.role !== 'ADMIN') {
        throw new DomainError(403, 'Must be group ADMIN or HOST_ADMIN');
      }
    }

    const inviteToken = `inv_${crypto.randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(this.now() + expiresInHours * 60 * 60 * 1000);

    await this.store.insertInvite({
      token: inviteToken,
      groupId,
      assignedRole,
      createdBy: caller.id,
      maxUses,
      expiresAt,
    });

    const serverUrl = this.resolveInviteServerUrl(requestOrigin);
    const qrPayload = QrInvitePayloadSchema.parse({
      v: 1,
      serverUrl,
      inviteToken,
      groupName: group.name,
    });

    return {
      ...qrPayload,
      joinUrl: `${serverUrl.replace(/\/$/, '')}/join?token=${inviteToken}`,
      assignedRole,
      maxUses,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async listInvites(caller: JwtUserPayload) {
    const invites = await this.store.listInvites({
      userId: caller.id,
      systemRole: caller.role,
    });
    return {
      invites: invites.map((r) => ({
        token: r.token,
        groupId: r.groupId,
        groupName: r.groupName,
        assignedRole: r.assignedRole,
        maxUses: r.maxUses,
        uses: r.uses,
        expiresAt: r.expiresAt.toISOString(),
      })),
    };
  }

  async deleteInvite(
    caller: JwtUserPayload,
    token: string,
  ): Promise<{ deleted: true; token: string }> {
    const trimmedToken = token.trim();
    const inv = trimmedToken ? await this.store.findInviteByToken(trimmedToken) : null;
    if (!inv) {
      throw new DomainError(404, 'Invite not found');
    }

    if (caller.role !== 'HOST_ADMIN') {
      const membership = await this.store.findMembership(caller.id, inv.groupId);
      if (membership?.role !== 'ADMIN') {
        throw new DomainError(403, 'Must be group ADMIN or HOST_ADMIN');
      }
    }

    if (!this.store.deleteInvite) {
      throw new DomainError(501, 'Invite deletion not supported by store');
    }

    await this.store.deleteInvite(trimmedToken);
    return { deleted: true, token: trimmedToken };
  }

  async createTrackerToken(
    caller: JwtUserPayload,
    rawInput: unknown,
    requestOrigin?: string,
  ): Promise<CreatedTrackerTokenResult> {
    const parsed = CreateTrackerTokenSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid tracker token payload', parsed.error.flatten());
    }
    const { expiresInDays } = parsed.data;
    const jti = crypto.randomUUID();
    const issued = await this.tokenService.issueTrackerToken(caller, {
      jti,
      expiresInDays,
      nowMs: this.now(),
    });
    if (this.sessionStore.saveTrackerTokenJti) {
      await this.sessionStore.saveTrackerTokenJti(caller.id, jti, expiresInDays);
    }

    const serverUrl = this.resolveInviteServerUrl(requestOrigin).replace(/\/$/, '');
    return {
      token: issued.token,
      expiresInDays: issued.expiresInDays,
      expiresAt: issued.expiresAt,
      serverUrl,
      owntracksUrl: `${serverUrl}/api/realtime/owntracks?token=${issued.token}`,
      overlandUrl: `${serverUrl}/api/realtime/overland?token=${issued.token}`,
    };
  }

  async revokeTrackerToken(userId: string): Promise<{ revoked: true }> {
    if (this.sessionStore.revokeTrackerTokenJti) {
      await this.sessionStore.revokeTrackerTokenJti(userId);
    }
    return { revoked: true };
  }

  async getTrackerTokenStatus(
    userId: string,
  ): Promise<{ active: boolean; ttlSeconds: number }> {
    if (this.sessionStore.getTrackerTokenStatus) {
      return this.sessionStore.getTrackerTokenStatus(userId);
    }
    return { active: false, ttlSeconds: 0 };
  }
}
