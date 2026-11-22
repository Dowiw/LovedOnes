'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Pause, Play, Terminal, Trash2 } from 'lucide-react';
import type { LogRetentionSettings } from '@loved-ones/shared';
import {
  apiFetchLogRetention,
  apiFetchRecentLogs,
  apiPruneLogs,
  apiUpdateLogRetention,
  formatBytes,
  getLogsWsUrl,
} from '@/lib/api';

interface ParsedLogLine {
  raw: string;
  time?: string;
  level?: number;
  service?: string;
  msg?: string;
  details?: string;
}

const LOG_META_OMIT_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'service', 'msg']);

function formatLogDetails(obj: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (LOG_META_OMIT_KEYS.has(k) || v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      parts.push(`${k}=[${v.join(',')}]`);
    } else if (typeof v === 'object') {
      parts.push(`${k}=${JSON.stringify(v)}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function parseLogLine(raw: string): ParsedLogLine {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      raw,
      time: typeof obj.time === 'string' || typeof obj.time === 'number' ? String(obj.time) : undefined,
      level: typeof obj.level === 'number' ? obj.level : undefined,
      service: typeof obj.service === 'string' ? obj.service : undefined,
      msg: typeof obj.msg === 'string' ? obj.msg : raw,
      details: formatLogDetails(obj),
    };
  } catch {
    return { raw, msg: raw };
  }
}

function getLevelMeta(level?: number): { label: string; color: string } {
  if (!level || level < 30) return { label: 'DEBUG', color: 'text-zinc-400' };
  if (level < 40) return { label: 'INFO ', color: 'text-zinc-100' };
  if (level < 50) return { label: 'WARN ', color: 'text-amber-300' };
  return { label: 'ERROR', color: 'text-rose-400' };
}

interface LiveLogTerminalProps {
  accessToken: string;
  onRetentionUpdated?: () => void;
}

const RETENTION_DAY_PRESETS = [1, 7, 14, 30, 90] as const;

export function LiveLogTerminal({ accessToken, onRetentionUpdated }: LiveLogTerminalProps) {
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retention, setRetention] = useState<LogRetentionSettings | null>(null);
  const [retentionDaysInput, setRetentionDaysInput] = useState('14');
  const [maxFilesInput, setMaxFilesInput] = useState('10');
  const [maxBufferInput, setMaxBufferInput] = useState('500');
  const [maxStorageInput, setMaxStorageInput] = useState('500');
  const [autoPruneInput, setAutoPruneInput] = useState(true);
  const [savingRetention, setSavingRetention] = useState(false);
  const [pruningNow, setPruningNow] = useState(false);
  const [retentionFeedback, setRetentionFeedback] = useState<string | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const syncRetentionForm = (s: LogRetentionSettings) => {
    setRetention(s);
    setRetentionDaysInput(String(s.retentionDays));
    setMaxFilesInput(String(s.maxFilesPerService));
    setMaxBufferInput(String(s.maxRecentEntries));
    setMaxStorageInput(String(s.maxStorageMb));
    setAutoPruneInput(s.autoPruneDiskLogs);
  };

  useEffect(() => {
    let active = true;
    void apiFetchLogRetention(accessToken)
      .then((s) => {
        if (active) syncRetentionForm(s);
      })
      .catch(() => {});
    void apiFetchRecentLogs(accessToken)
      .then((initial) => {
        if (active) {
          setLines(initial.map(parseLogLine));
        }
      })
      .catch(() => {});

    const ws = new WebSocket(getLogsWsUrl(accessToken));
    ws.onopen = () => {
      if (active) setConnected(true);
    };
    ws.onclose = () => {
      if (active) setConnected(false);
    };
    ws.onmessage = (event) => {
      if (!active || pausedRef.current) return;
      const entry = parseLogLine(String(event.data));
      setLines((prev) => [...prev.slice(-499), entry]);
    };

    return () => {
      active = false;
      ws.close();
    };
  }, [accessToken]);

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, paused]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => l.raw.toLowerCase().includes(q));
  }, [lines, filter]);

  async function handleSaveRetention(e: React.FormEvent) {
    e.preventDefault();
    setSavingRetention(true);
    setRetentionError(null);
    setRetentionFeedback(null);
    try {
      const result = await apiUpdateLogRetention(accessToken, {
        retentionDays: Math.min(365, Math.max(1, Math.round(Number(retentionDaysInput) || 14))),
        maxFilesPerService: Math.min(100, Math.max(1, Math.round(Number(maxFilesInput) || 10))),
        maxRecentEntries: Math.min(10000, Math.max(50, Math.round(Number(maxBufferInput) || 500))),
        maxStorageMb: Math.min(50000, Math.max(10, Math.round(Number(maxStorageInput) || 500))),
        autoPruneDiskLogs: autoPruneInput,
      });
      syncRetentionForm(result.settings);
      const summary =
        result.deletedFiles > 0 || result.trimmedRedisEntries > 0
          ? `Saved · pruned ${result.deletedFiles} files (${formatBytes(result.freedBytes)}) & ${result.trimmedRedisEntries} buffer entries`
          : `Saved (${result.settings.retentionDays}d retention active)`;
      setRetentionFeedback(summary);
      if (result.trimmedRedisEntries > 0) {
        const refreshed = await apiFetchRecentLogs(accessToken).catch(() => null);
        if (refreshed) setLines(refreshed.map(parseLogLine));
      }
      onRetentionUpdated?.();
    } catch (err) {
      setRetentionError(err instanceof Error ? err.message : 'Failed to save log retention');
    } finally {
      setSavingRetention(false);
    }
  }

  async function handlePruneNow() {
    setPruningNow(true);
    setRetentionError(null);
    setRetentionFeedback(null);
    try {
      const result = await apiPruneLogs(accessToken);
      syncRetentionForm(result.settings);
      setRetentionFeedback(
        result.deletedFiles > 0 || result.trimmedRedisEntries > 0
          ? `Pruned ${result.deletedFiles} files (${formatBytes(result.freedBytes)}) & ${result.trimmedRedisEntries} buffer entries`
          : 'All logs are already within retention limits',
      );
      if (result.trimmedRedisEntries > 0) {
        const refreshed = await apiFetchRecentLogs(accessToken).catch(() => null);
        if (refreshed) setLines(refreshed.map(parseLogLine));
      }
      onRetentionUpdated?.();
    } catch (err) {
      setRetentionError(err instanceof Error ? err.message : 'Failed to prune expired logs');
    } finally {
      setPruningNow(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Terminal className="h-4 w-4 text-zinc-950 dark:text-zinc-100" />
          <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">Live Service Logs</span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              connected
                ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-white dark:bg-zinc-950' : 'bg-zinc-400'
              }`}
            />
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs (user, group, action)..."
            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
          />
          <button
            type="button"
            onClick={() => setRetentionOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              retentionOpen
                ? 'border-zinc-950 bg-zinc-950 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-zinc-50'
            }`}
          >
            <Clock className="h-3.5 w-3.5" />
            Retention{retention ? ` · ${retention.retentionDays}d` : ''}
          </button>
          <button
            type="button"
            onClick={() => setShowRawJson((r) => !r)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              showRawJson
                ? 'border-zinc-950 bg-zinc-950 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-zinc-50'
            }`}
          >
            {showRawJson ? 'Raw JSON' : 'Readable'}
          </button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-zinc-50"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => setLines([])}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-zinc-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>

      {retentionOpen && (
        <form
          onSubmit={(e) => void handleSaveRetention(e)}
          className="space-y-3 border-b border-zinc-200 bg-zinc-50/90 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950/60"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-100">Log Retention Policy</h3>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Controls how long rotated disk logs and Redis live terminal entries are kept before pruning.
              </p>
            </div>
            <div className="flex items-center gap-1">
              {RETENTION_DAY_PRESETS.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setRetentionDaysInput(String(days))}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                    Number(retentionDaysInput) === days
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                      : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <span>Keep logs (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={retentionDaysInput}
                onChange={(e) => setRetentionDaysInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="space-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <span>Max files / service</span>
              <input
                type="number"
                min={1}
                max={100}
                value={maxFilesInput}
                onChange={(e) => setMaxFilesInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="space-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <span>Live terminal buffer lines</span>
              <input
                type="number"
                min={50}
                max={10000}
                value={maxBufferInput}
                onChange={(e) => setMaxBufferInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <label className="space-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <span>Disk alert threshold (MB)</span>
              <input
                type="number"
                min={10}
                max={50000}
                value={maxStorageInput}
                onChange={(e) => setMaxStorageInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={autoPruneInput}
                onChange={(e) => setAutoPruneInput(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-950 dark:border-zinc-600 dark:accent-zinc-100"
              />
              <span>Automatically prune expired rotated logs</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pruningNow || savingRetention}
                onClick={() => void handlePruneNow()}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                {pruningNow ? 'Pruning...' : 'Prune Expired Now'}
              </button>
              <button
                type="submit"
                disabled={savingRetention || pruningNow}
                className="rounded-lg bg-zinc-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
              >
                {savingRetention ? 'Saving...' : 'Save Retention'}
              </button>
            </div>
          </div>

          {retentionError && (
            <div className="text-[11px] font-medium text-rose-600 dark:text-rose-400">{retentionError}</div>
          )}
          {retentionFeedback && (
            <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{retentionFeedback}</div>
          )}
        </form>
      )}

      <div className="h-80 overflow-y-auto bg-zinc-950 p-4 font-mono text-xs leading-5">
        {filtered.length === 0 ? (
          <div className="text-zinc-500">Waiting for structured log events on logs:stream...</div>
        ) : (
          filtered.map((item, idx) => {
            const meta = getLevelMeta(item.level);
            return (
              <div key={`${idx}-${item.time ?? ''}`} className="whitespace-pre-wrap break-all py-0.5">
                <span className="text-zinc-500">
                  {item.time ? new Date(item.time).toLocaleTimeString() : '--:--:--'}
                </span>{' '}
                <span className={meta.color}>[{meta.label}]</span>{' '}
                {item.service && <span className="text-sky-400">[{item.service}]</span>}{' '}
                {showRawJson ? (
                  <span className="text-zinc-200">{item.raw}</span>
                ) : (
                  <>
                    <span className="text-zinc-100">{item.msg}</span>
                    {item.details && (
                      <span className="ml-2 text-[11px] text-zinc-400">({item.details})</span>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
