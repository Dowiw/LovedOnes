import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  ScheduledSystemUpdate,
  ScheduleSystemUpdateSchema,
  SystemUpdateStatus,
  SystemUpdateStatusSchema,
  TriggerSystemUpdateSchema,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

export interface SystemUpdateDriver {
  getStatus(refresh: boolean): Promise<SystemUpdateStatus>;
  applyUpdate(options: { rebuildEvenIfCurrent: boolean }): Promise<{
    statusCode: number;
    status: SystemUpdateStatus;
  }>;
  clearError?(): Promise<SystemUpdateStatus>;
}

export interface SystemUpdateScheduleStore {
  get(): Promise<ScheduledSystemUpdate | null>;
  set(schedule: ScheduledSystemUpdate | null, updatedBy?: string | null): Promise<void>;
}

class InMemorySystemUpdateScheduleStore implements SystemUpdateScheduleStore {
  private current: ScheduledSystemUpdate | null = null;

  async get(): Promise<ScheduledSystemUpdate | null> {
    return this.current;
  }

  async set(schedule: ScheduledSystemUpdate | null): Promise<void> {
    this.current = schedule;
  }
}

export interface SystemUpdateModuleOptions {
  driver?: SystemUpdateDriver;
  updaterUrl?: string;
  jwtSecret: string;
  stateFilePath?: string;
  allowRemoteUpdate?: boolean;
  scheduleStore?: SystemUpdateScheduleStore;
  now?: () => number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_SCHEDULE_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_LEAD_MS = 10 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function buildDisabledStatus(reason: string): SystemUpdateStatus {
  return {
    enabled: false,
    disabledReason: reason,
    phase: 'idle',
    running: false,
    branch: null,
    currentCommit: null,
    currentCommitMessage: null,
    upstreamBranch: null,
    remoteCommit: null,
    commitsBehind: 0,
    pendingCommits: [],
    updateAvailable: false,
    workingTreeDirty: false,
    lastCheckedAt: null,
    startedAt: null,
    finishedAt: null,
    targetCommit: null,
    error: null,
    logs: [],
  };
}

class HttpSystemUpdateDriver implements SystemUpdateDriver {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly stateFilePath?: string;

  constructor(options: { baseUrl: string; jwtSecret: string; stateFilePath?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.authToken = createHmac('sha256', options.jwtSecret)
      .update('lovedones-system-updater')
      .digest('hex');
    this.stateFilePath = options.stateFilePath;
  }

  private async readPersistedStateFallback(): Promise<SystemUpdateStatus | null> {
    if (!this.stateFilePath) return null;
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SystemUpdateStatus>;
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        ...buildDisabledStatus(''),
        enabled: true,
        disabledReason: null,
        phase: parsed.phase ?? 'restarting',
        running: Boolean(parsed.running),
        startedAt: parsed.startedAt ?? null,
        finishedAt: parsed.finishedAt ?? null,
        targetCommit: parsed.targetCommit ?? null,
        lastCheckedAt: parsed.lastCheckedAt ?? null,
        error: parsed.error ?? null,
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      };
    } catch {
      return null;
    }
  }

  async getStatus(refresh: boolean): Promise<SystemUpdateStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/status${refresh ? '?refresh=1' : ''}`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new DomainError(res.status >= 500 ? 502 : res.status, text || `Updater error ${res.status}`);
      }
      const json = await res.json();
      return SystemUpdateStatusSchema.parse(json);
    } catch (err) {
      if (!refresh) {
        const fallback = await this.readPersistedStateFallback();
        if (fallback?.running) {
          return fallback;
        }
      }
      if (err instanceof DomainError) throw err;
      throw new DomainError(
        503,
        'System updater service is temporarily unreachable (may be restarting)',
      );
    }
  }

  async applyUpdate(options: { rebuildEvenIfCurrent: boolean }): Promise<{
    statusCode: number;
    status: SystemUpdateStatus;
  }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/apply`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new DomainError(503, 'System updater service is unavailable');
    }

    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      status?: unknown;
    };
    if (!res.ok) {
      throw new DomainError(
        res.status >= 500 ? 502 : res.status,
        payload.error ?? `Failed to trigger system update (${res.status})`,
      );
    }
    return {
      statusCode: res.status,
      status: SystemUpdateStatusSchema.parse(payload),
    };
  }

  async clearError(): Promise<SystemUpdateStatus> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/clear`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DomainError(503, 'System updater service is unavailable');
    }

    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new DomainError(
        res.status >= 500 ? 502 : res.status,
        payload.error ?? `Failed to clear system update status (${res.status})`,
      );
    }
    return SystemUpdateStatusSchema.parse(payload);
  }
}

/**
 * Coordinates Host Admin remote update checks and container-stack rebuilds via an
 * authenticated internal updater sidecar (or disabled fallback outside Compose).
 */
export class SystemUpdateModule {
  private readonly driver: SystemUpdateDriver | null;
  private readonly allowRemoteUpdate: boolean;
  private readonly scheduleStore: SystemUpdateScheduleStore;
  private readonly now: () => number;
  private readonly onLog?: SystemUpdateModuleOptions['onLog'];
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private runningScheduledExecution = false;

  constructor(options: SystemUpdateModuleOptions) {
    this.allowRemoteUpdate = options.allowRemoteUpdate ?? true;
    this.scheduleStore = options.scheduleStore ?? new InMemorySystemUpdateScheduleStore();
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    if (options.driver) {
      this.driver = options.driver;
    } else if (options.updaterUrl) {
      this.driver = new HttpSystemUpdateDriver({
        baseUrl: options.updaterUrl,
        jwtSecret: options.jwtSecret,
        stateFilePath: options.stateFilePath,
      });
    } else {
      this.driver = null;
    }
  }

  private clearTimer(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  private armTimer(schedule: ScheduledSystemUpdate): void {
    this.clearTimer();
    const targetMs = Date.parse(schedule.scheduledFor);
    if (!Number.isFinite(targetMs)) return;
    const delayMs = targetMs - this.now();
    if (delayMs <= 0) {
      this.scheduleTimer = setTimeout(() => {
        void this.executeScheduledUpdateIfDue();
      }, 0);
      this.scheduleTimer.unref?.();
      return;
    }
    const clampedDelay = Math.min(delayMs, MAX_TIMEOUT_MS);
    this.scheduleTimer = setTimeout(() => {
      if (delayMs > MAX_TIMEOUT_MS) {
        void this.initScheduleTimer();
      } else {
        void this.executeScheduledUpdateIfDue();
      }
    }, clampedDelay);
    this.scheduleTimer.unref?.();
  }

  async initScheduleTimer(): Promise<void> {
    this.clearTimer();
    const schedule = await this.scheduleStore.get().catch(() => null);
    if (!schedule) return;
    const targetMs = Date.parse(schedule.scheduledFor);
    if (!Number.isFinite(targetMs)) {
      await this.scheduleStore.set(null).catch(() => {});
      return;
    }
    if (targetMs <= this.now()) {
      await this.executeScheduledUpdateIfDue();
      return;
    }
    this.armTimer(schedule);
  }

  async executeScheduledUpdateIfDue(): Promise<boolean> {
    if (this.runningScheduledExecution) return false;
    const schedule = await this.scheduleStore.get().catch(() => null);
    if (!schedule) return false;
    const targetMs = Date.parse(schedule.scheduledFor);
    if (!Number.isFinite(targetMs)) {
      await this.scheduleStore.set(null).catch(() => {});
      return false;
    }
    if (targetMs > this.now()) {
      this.armTimer(schedule);
      return false;
    }

    this.runningScheduledExecution = true;
    this.clearTimer();
    try {
      // Clear schedule before invoking applyUpdate so container restart can never trigger a loop.
      await this.scheduleStore.set(null, schedule.scheduledByUserId).catch(() => {});

      if (!this.allowRemoteUpdate || !this.driver) {
        this.onLog?.(
          'warn',
          'Skipped scheduled system update because remote updater is disabled or unconfigured',
          {
            action: 'system.scheduled_update_skipped',
            userId: schedule.scheduledByUserId,
            username: schedule.scheduledByUsername,
            scheduledFor: schedule.scheduledFor,
          },
        );
        return false;
      }

      const currentStatus = await this.driver.getStatus(false).catch(() => null);
      if (currentStatus?.running || currentStatus?.workingTreeDirty) {
        this.onLog?.(
          'warn',
          currentStatus.workingTreeDirty
            ? 'Skipped scheduled system update because working tree has uncommitted changes'
            : 'Skipped scheduled system update because an update is already running',
          {
            action: 'system.scheduled_update_skipped',
            userId: schedule.scheduledByUserId,
            username: schedule.scheduledByUsername,
            scheduledFor: schedule.scheduledFor,
            workingTreeDirty: currentStatus.workingTreeDirty,
            running: currentStatus.running,
          },
        );
        return false;
      }

      this.onLog?.(
        'info',
        `Starting scheduled system update & restart requested by ${schedule.scheduledByUsername}`,
        {
          action: 'system.scheduled_update_started',
          userId: schedule.scheduledByUserId,
          username: schedule.scheduledByUsername,
          scheduledFor: schedule.scheduledFor,
          rebuildEvenIfCurrent: schedule.rebuildEvenIfCurrent,
        },
      );
      await this.driver.applyUpdate({ rebuildEvenIfCurrent: schedule.rebuildEvenIfCurrent });
      return true;
    } catch (err) {
      this.onLog?.('error', 'Scheduled system update execution failed', {
        action: 'system.scheduled_update_failed',
        userId: schedule.scheduledByUserId,
        username: schedule.scheduledByUsername,
        scheduledFor: schedule.scheduledFor,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      this.runningScheduledExecution = false;
    }
  }

  async getScheduledUpdate(): Promise<ScheduledSystemUpdate | null> {
    return this.scheduleStore.get();
  }

  async getStatus(refresh = false): Promise<SystemUpdateStatus> {
    const scheduledUpdate = await this.scheduleStore.get().catch(() => null);
    if (!this.allowRemoteUpdate) {
      return {
        ...buildDisabledStatus(
          'Remote system updates are disabled via ALLOW_REMOTE_SYSTEM_UPDATE=false.',
        ),
        scheduledUpdate,
      };
    }
    if (!this.driver) {
      return {
        ...buildDisabledStatus(
          'Remote system updater sidecar is not configured in this runtime (start via Docker Compose ./bin/start to enable).',
        ),
        scheduledUpdate,
      };
    }
    const status = await this.driver.getStatus(refresh);
    return {
      ...status,
      scheduledUpdate,
    };
  }

  async scheduleUpdate(
    actor: { id: string; username: string },
    rawInput: unknown,
  ): Promise<SystemUpdateStatus> {
    const parsed = ScheduleSystemUpdateSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid schedule update request', parsed.error.flatten());
    }
    if (!this.allowRemoteUpdate) {
      throw new DomainError(403, 'Remote system updates are disabled on this server');
    }
    if (!this.driver) {
      throw new DomainError(
        503,
        'Remote system updater sidecar is not configured in this runtime',
      );
    }

    const currentStatus = await this.driver.getStatus(false);
    if (currentStatus.running) {
      throw new DomainError(409, 'A system update is already in progress');
    }
    if (currentStatus.workingTreeDirty) {
      throw new DomainError(
        409,
        'Cannot schedule update while the host repository has uncommitted tracked changes',
      );
    }

    const nowMs = this.now();
    let targetMs: number;
    if (parsed.data.runAt) {
      targetMs = Date.parse(parsed.data.runAt);
      if (!Number.isFinite(targetMs)) {
        throw new DomainError(400, 'Invalid runAt ISO timestamp');
      }
    } else {
      targetMs = nowMs + (parsed.data.delayMinutes ?? 15) * 60_000;
    }

    if (targetMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
      throw new DomainError(400, 'Scheduled update time must be in the future');
    }
    if (targetMs > nowMs + MAX_SCHEDULE_LOOKAHEAD_MS) {
      throw new DomainError(400, 'Scheduled update time cannot be more than 30 days ahead');
    }

    const schedule: ScheduledSystemUpdate = {
      scheduledFor: new Date(targetMs).toISOString(),
      scheduledByUserId: actor.id,
      scheduledByUsername: actor.username,
      rebuildEvenIfCurrent: parsed.data.rebuildEvenIfCurrent,
      createdAt: new Date(nowMs).toISOString(),
    };

    await this.scheduleStore.set(schedule, actor.id);
    this.armTimer(schedule);

    return {
      ...currentStatus,
      scheduledUpdate: schedule,
    };
  }

  async cancelScheduledUpdate(actor: { id: string; username: string }): Promise<SystemUpdateStatus> {
    this.clearTimer();
    await this.scheduleStore.set(null, actor.id);
    return this.getStatus(false);
  }

  async triggerUpdate(rawInput: unknown): Promise<{
    statusCode: number;
    status: SystemUpdateStatus;
  }> {
    const parsed = TriggerSystemUpdateSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid system update request', parsed.error.flatten());
    }
    if (!this.allowRemoteUpdate) {
      throw new DomainError(403, 'Remote system updates are disabled on this server');
    }
    if (!this.driver) {
      throw new DomainError(
        503,
        'Remote system updater sidecar is not configured in this runtime',
      );
    }
    // Clear any pending schedule when triggering immediately so it doesn't run twice.
    this.clearTimer();
    await this.scheduleStore.set(null).catch(() => {});
    const res = await this.driver.applyUpdate(parsed.data);
    return {
      statusCode: res.statusCode,
      status: {
        ...res.status,
        scheduledUpdate: null,
      },
    };
  }

  async dismissError(): Promise<SystemUpdateStatus> {
    if (!this.allowRemoteUpdate) {
      throw new DomainError(403, 'Remote system updates are disabled on this server');
    }
    if (!this.driver) {
      throw new DomainError(
        503,
        'Remote system updater sidecar is not configured in this runtime',
      );
    }
    const scheduledUpdate = await this.scheduleStore.get().catch(() => null);
    const status = this.driver.clearError
      ? await this.driver.clearError()
      : await this.driver.getStatus(false);
    return {
      ...status,
      scheduledUpdate,
    };
  }
}
