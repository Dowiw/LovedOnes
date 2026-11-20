import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number.parseInt(process.env.PORT ?? '4010', 10);
const REPO_DIR = process.env.REPO_DIR ?? '/repo';
const STATE_FILE = process.env.STATE_FILE ?? '/var/log/app/system-update.json';
const JWT_SECRET =
  process.env.JWT_SECRET ?? 'dev-jwt-secret-key-minimum-32-characters-long';
const ALLOW_REMOTE = process.env.ALLOW_REMOTE_SYSTEM_UPDATE !== 'false';
const DOCKER_SOCKET = '/var/run/docker.sock';
const MAX_LOG_LINES = 120;

function computeUpdaterSecret() {
  return createHmac('sha256', JWT_SECRET)
    .update('lovedones-system-updater')
    .digest('hex');
}

function isAuthorized(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const supplied = auth.slice(7).trim();
  const expected = computeUpdaterSecret();
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState(next) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function appendLogLines(state, chunk) {
  const incoming = chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (incoming.length === 0) return;
  const combined = [...(state.logs ?? []), ...incoming];
  state.logs = combined.slice(-MAX_LOG_LINES);
  writeState(state);
}

function resolveGitOwnerIds(repoDir) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      const stat = fs.statSync(path.join(repoDir, '.git'));
      if (stat.uid > 0) {
        return { uid: stat.uid, gid: stat.gid };
      }
    } catch {
      // ignore
    }
  }
  return {};
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      uid: options.uid,
      gid: options.gid,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const timeoutMs = options.timeoutMs ?? 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killedByTimeout = true;
            child.kill('SIGTERM');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (buf) => {
      const text = buf.toString('utf8');
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      options.onOutput?.(text);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runGit(repoDir, args, opts = {}) {
  const owner = resolveGitOwnerIds(repoDir);
  return runCommand('git', ['-c', 'safe.directory=*', '-C', repoDir, ...args], {
    ...opts,
    uid: owner.uid,
    gid: owner.gid,
    env: {
      HOME: '/tmp',
      GIT_TERMINAL_PROMPT: '0',
      ...(opts.env ?? {}),
    },
  });
}

function dockerApiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path: apiPath,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            // keep text
          }
          if ((res.statusCode ?? 500) >= 400) {
            const msg =
              typeof parsed === 'object' && parsed && parsed.message
                ? parsed.message
                : text || `Docker API ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function inspectHostContext() {
  const selfId = os.hostname();
  const container = await dockerApiRequest('GET', `/containers/${encodeURIComponent(selfId)}/json`);
  const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
  const repoMount = mounts.find((m) => m.Destination === REPO_DIR);
  const logsDir = path.dirname(STATE_FILE);
  const logsMount = mounts.find((m) => m.Destination === logsDir);
  const labels = container?.Config?.Labels ?? {};
  const projectName = labels['com.docker.compose.project'] ?? 'lovedones';
  const image = container?.Config?.Image ?? 'lovedones-system-updater';

  const filter = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${projectName}`] }),
  );
  const siblings = await dockerApiRequest('GET', `/containers/json?filters=${filter}`);
  const activeServices = new Set(
    (Array.isArray(siblings) ? siblings : [])
      .map((c) => c?.Labels?.['com.docker.compose.service'])
      .filter(Boolean),
  );
  const activeProfiles = [];
  if (activeServices.has('cloudflared')) activeProfiles.push('tunnel');
  if (activeServices.has('map-service')) activeProfiles.push('standalone-maps');

  return {
    image,
    projectName,
    hostRepoDir: repoMount?.Source ?? REPO_DIR,
    hostLogsDir: logsMount?.Source ?? logsDir,
    activeProfiles,
  };
}

async function isWorkerContainerActive(jobId) {
  if (!jobId) return false;
  try {
    const filter = encodeURIComponent(
      JSON.stringify({ label: [`lovedones.updater.job=${jobId}`] }),
    );
    const list = await dockerApiRequest('GET', `/containers/json?filters=${filter}`);
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

async function inspectGitStatus(repoDir, refresh) {
  let fetchError = null;
  let lastCheckedAt = readState()?.lastCheckedAt ?? null;

  if (refresh) {
    try {
      const fetchRes = await runGit(repoDir, ['fetch', '--prune'], { timeoutMs: 25_000 });
      lastCheckedAt = new Date().toISOString();
      if (fetchRes.code !== 0) {
        fetchError = (fetchRes.stderr || fetchRes.stdout || 'git fetch failed').trim();
      }
    } catch (err) {
      lastCheckedAt = new Date().toISOString();
      fetchError = err instanceof Error ? err.message : 'git fetch failed';
    }
  }

  const branchRes = await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const shaRes = await runGit(repoDir, ['rev-parse', '--short', 'HEAD']);
  const msgRes = await runGit(repoDir, ['log', '-1', '--format=%s']);
  const dirtyRes = await runGit(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  const upstreamRes = await runGit(repoDir, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
  const currentCommit = shaRes.code === 0 ? shaRes.stdout.trim() : null;
  const currentCommitMessage = msgRes.code === 0 ? msgRes.stdout.trim() : null;
  const workingTreeDirty = dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : false;
  const upstreamBranch = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  let remoteCommit = null;
  let commitsBehind = 0;
  const pendingCommits = [];

  if (upstreamBranch) {
    const remoteShaRes = await runGit(repoDir, ['rev-parse', '--short', upstreamBranch]);
    if (remoteShaRes.code === 0) remoteCommit = remoteShaRes.stdout.trim();

    const countRes = await runGit(repoDir, ['rev-list', '--count', `HEAD..${upstreamBranch}`]);
    if (countRes.code === 0) {
      commitsBehind = Math.max(0, Number.parseInt(countRes.stdout.trim(), 10) || 0);
    }

    if (commitsBehind > 0) {
      const logRes = await runGit(repoDir, [
        'log',
        '--max-count=10',
        '--format=%h%x1f%s%x1f%an%x1f%cI',
        `HEAD..${upstreamBranch}`,
      ]);
      if (logRes.code === 0) {
        for (const line of logRes.stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [sha, message, author, date] = line.split('\x1f');
          pendingCommits.push({
            sha: sha ?? '',
            message: message ?? '',
            author: author || undefined,
            date: date || undefined,
          });
        }
      }
    }
  }

  return {
    branch,
    currentCommit,
    currentCommitMessage,
    upstreamBranch,
    remoteCommit,
    commitsBehind,
    pendingCommits,
    updateAvailable: commitsBehind > 0,
    workingTreeDirty,
    lastCheckedAt,
    fetchError,
  };
}

async function buildStatusResponse(refresh = false) {
  const [gitInfo, persisted] = await Promise.all([
    inspectGitStatus(REPO_DIR, refresh),
    Promise.resolve(readState()),
  ]);

  let job = persisted ?? {
    jobId: null,
    phase: 'idle',
    running: false,
    startedAt: null,
    finishedAt: null,
    targetCommit: null,
    error: null,
    logs: [],
    lastCheckedAt: gitInfo.lastCheckedAt,
  };

  if (gitInfo.lastCheckedAt && job.lastCheckedAt !== gitInfo.lastCheckedAt) {
    job = { ...job, lastCheckedAt: gitInfo.lastCheckedAt };
    writeState(job);
  }

  if (job.running) {
    const stillActive = await isWorkerContainerActive(job.jobId);
    if (!stillActive) {
      // Worker exited right before final write or crashed unexpectedly
      const postRefreshed = readState();
      if (postRefreshed && !postRefreshed.running) {
        job = postRefreshed;
      } else {
        job = {
          ...job,
          phase: 'failed',
          running: false,
          finishedAt: new Date().toISOString(),
          error: 'Update worker container exited before completing.',
        };
        writeState(job);
      }
    }
  }

  return {
    enabled: ALLOW_REMOTE,
    disabledReason: ALLOW_REMOTE
      ? null
      : 'Remote updates disabled via ALLOW_REMOTE_SYSTEM_UPDATE=false',
    phase: job.phase ?? 'idle',
    running: Boolean(job.running),
    branch: gitInfo.branch,
    currentCommit: gitInfo.currentCommit,
    currentCommitMessage: gitInfo.currentCommitMessage,
    upstreamBranch: gitInfo.upstreamBranch,
    remoteCommit: gitInfo.remoteCommit,
    commitsBehind: gitInfo.commitsBehind,
    pendingCommits: gitInfo.pendingCommits,
    updateAvailable: gitInfo.updateAvailable,
    workingTreeDirty: gitInfo.workingTreeDirty,
    lastCheckedAt: gitInfo.lastCheckedAt ?? job.lastCheckedAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    targetCommit: job.targetCommit ?? null,
    error: gitInfo.fetchError ?? job.error ?? null,
    logs: Array.isArray(job.logs) ? job.logs : [],
  };
}

async function triggerUpdate(rebuildEvenIfCurrent) {
  if (!ALLOW_REMOTE) {
    return { statusCode: 403, body: { error: 'Remote system updates are disabled on this server' } };
  }

  const current = await buildStatusResponse(true);
  if (current.running) {
    return { statusCode: 409, body: { error: 'A system update is already in progress', status: current } };
  }
  if (current.workingTreeDirty) {
    return {
      statusCode: 409,
      body: {
        error:
          'Tracked repository files have uncommitted changes on the host; commit or stash them before remote update.',
        status: current,
      },
    };
  }
  if (!current.updateAvailable && !rebuildEvenIfCurrent) {
    return {
      statusCode: 200,
      body: current,
    };
  }
  if (current.updateAvailable && !current.upstreamBranch) {
    return {
      statusCode: 409,
      body: { error: 'No git upstream tracking branch is configured', status: current },
    };
  }

  const hostCtx = await inspectHostContext();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const initialPhase = current.updateAvailable ? 'pulling' : 'building';

  const initialState = {
    jobId,
    phase: initialPhase,
    running: true,
    lastCheckedAt: current.lastCheckedAt ?? now,
    startedAt: now,
    finishedAt: null,
    targetCommit: current.remoteCommit ?? current.currentCommit,
    error: null,
    logs: [
      `[${now}] Starting remote update on ${current.branch ?? 'HEAD'} (project ${hostCtx.projectName})`,
    ],
  };
  writeState(initialState);

  const created = await dockerApiRequest('POST', '/containers/create', {
    Image: hostCtx.image,
    Cmd: ['node', '/app/server.mjs', '--worker'],
    WorkingDir: hostCtx.hostRepoDir,
    Labels: {
      'lovedones.updater.job': jobId,
    },
    Env: [
      `REPO_DIR=${hostCtx.hostRepoDir}`,
      `STATE_FILE=${STATE_FILE}`,
      `COMPOSE_PROJECT_NAME=${hostCtx.projectName}`,
      `ACTIVE_PROFILES=${hostCtx.activeProfiles.join(',')}`,
      `UPDATE_JOB_ID=${jobId}`,
      `DO_GIT_PULL=${current.updateAvailable ? '1' : '0'}`,
      'COMPOSE_INTERACTIVE_NO_CLI=1',
    ],
    HostConfig: {
      AutoRemove: true,
      Binds: [
        `${hostCtx.hostRepoDir}:${hostCtx.hostRepoDir}`,
        `${hostCtx.hostLogsDir}:${path.dirname(STATE_FILE)}`,
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
      ],
    },
  });

  if (!created?.Id) {
    throw new Error('Failed to create system-updater worker container');
  }

  await dockerApiRequest('POST', `/containers/${created.Id}/start`);

  return {
    statusCode: 202,
    body: await buildStatusResponse(false),
  };
}

async function runDetachedWorker() {
  const repoDir = process.env.REPO_DIR ?? REPO_DIR;
  const projectName = process.env.COMPOSE_PROJECT_NAME ?? 'lovedones';
  const profiles = (process.env.ACTIVE_PROFILES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const doPull = process.env.DO_GIT_PULL === '1';

  const state = readState() ?? {
    jobId: process.env.UPDATE_JOB_ID ?? randomUUID(),
    phase: doPull ? 'pulling' : 'building',
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    targetCommit: null,
    error: null,
    logs: [],
    lastCheckedAt: new Date().toISOString(),
  };

  const composeBase = ['compose', '--project-name', projectName, '--project-directory', repoDir];
  for (const profile of profiles) {
    composeBase.push('--profile', profile);
  }
  composeBase.push('-f', path.join(repoDir, 'docker-compose.yml'));

  try {
    if (doPull) {
      state.phase = 'pulling';
      appendLogLines(state, 'Pulling fast-forward git updates from origin...');
      const pullRes = await runGit(repoDir, ['pull', '--ff-only'], {
        timeoutMs: 60_000,
        onOutput: (chunk) => appendLogLines(state, chunk),
      });
      if (pullRes.code !== 0) {
        throw new Error(`git pull failed (exit ${pullRes.code})`);
      }
      const headRes = await runGit(repoDir, ['rev-parse', '--short', 'HEAD']);
      if (headRes.code === 0) {
        state.targetCommit = headRes.stdout.trim();
        writeState(state);
      }
    }

    state.phase = 'building';
    appendLogLines(state, 'Building web-dashboard image...');
    const webBuild = await runCommand('docker', [...composeBase, 'build', 'web-dashboard'], {
      cwd: repoDir,
      timeoutMs: 900_000,
      onOutput: (chunk) => appendLogLines(state, chunk),
    });
    if (webBuild.code !== 0) {
      throw new Error(`docker compose build web-dashboard failed (exit ${webBuild.code})`);
    }

    appendLogLines(state, 'Building remaining service images...');
    const allBuild = await runCommand('docker', [...composeBase, 'build'], {
      cwd: repoDir,
      timeoutMs: 900_000,
      onOutput: (chunk) => appendLogLines(state, chunk),
    });
    if (allBuild.code !== 0) {
      throw new Error(`docker compose build failed (exit ${allBuild.code})`);
    }

    state.phase = 'restarting';
    appendLogLines(state, 'Recreating updated containers and waiting for healthchecks...');
    const upRes = await runCommand('docker', [...composeBase, 'up', '-d', '--no-build', '--wait'], {
      cwd: repoDir,
      timeoutMs: 600_000,
      onOutput: (chunk) => appendLogLines(state, chunk),
    });
    if (upRes.code !== 0) {
      throw new Error(`docker compose up failed (exit ${upRes.code})`);
    }

    const headAfter = await runGit(repoDir, ['rev-parse', '--short', 'HEAD']);
    if (headAfter.code === 0) {
      state.targetCommit = headAfter.stdout.trim();
    }
    state.phase = 'completed';
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.error = null;
    appendLogLines(
      state,
      `[${state.finishedAt}] System update completed cleanly (${state.targetCommit ?? 'current'}).`,
    );
  } catch (err) {
    state.phase = 'failed';
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.error = err instanceof Error ? err.message : 'System update failed';
    appendLogLines(state, `[${state.finishedAt}] ERROR: ${state.error}`);
    process.exitCode = 1;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

if (process.argv.includes('--worker')) {
  await runDetachedWorker();
} else {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'system-updater' });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      if (req.method === 'GET' && reqUrl.pathname === '/status') {
        const refresh = reqUrl.searchParams.get('refresh') === '1';
        const status = await buildStatusResponse(refresh);
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/apply') {
        const body = await readJsonBody(req);
        const result = await triggerUpdate(Boolean(body?.rebuildEvenIfCurrent));
        sendJson(res, result.statusCode, result.body);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Updater internal error';
      sendJson(res, 500, { error: msg });
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ service: 'system-updater', port: PORT, msg: 'listening' }));
  });
}
