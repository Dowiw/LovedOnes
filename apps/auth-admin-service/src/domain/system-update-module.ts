import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import {
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
}

export interface SystemUpdateModuleOptions {
  driver?: SystemUpdateDriver;
  updaterUrl?: string;
  jwtSecret: string;
  stateFilePath?: string;
  allowRemoteUpdate?: boolean;
}

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
}

/**
 * Coordinates Host Admin remote update checks and container-stack rebuilds via an
 * authenticated internal updater sidecar (or disabled fallback outside Compose).
 */
export class SystemUpdateModule {
  private readonly driver: SystemUpdateDriver | null;
  private readonly allowRemoteUpdate: boolean;

  constructor(options: SystemUpdateModuleOptions) {
    this.allowRemoteUpdate = options.allowRemoteUpdate ?? true;
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

  async getStatus(refresh = false): Promise<SystemUpdateStatus> {
    if (!this.allowRemoteUpdate) {
      return buildDisabledStatus(
        'Remote system updates are disabled via ALLOW_REMOTE_SYSTEM_UPDATE=false.',
      );
    }
    if (!this.driver) {
      return buildDisabledStatus(
        'Remote system updater sidecar is not configured in this runtime (start via Docker Compose ./bin/start to enable).',
      );
    }
    return this.driver.getStatus(refresh);
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
    return this.driver.applyUpdate(parsed.data);
  }
}
