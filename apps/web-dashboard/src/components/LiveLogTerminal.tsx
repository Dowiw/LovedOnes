'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Terminal, Trash2 } from 'lucide-react';
import { apiFetchRecentLogs, getLogsWsUrl } from '@/lib/api';

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
}

export function LiveLogTerminal({ accessToken }: LiveLogTerminalProps) {
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let active = true;
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

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <Terminal className="h-4 w-4 text-zinc-950" />
          <span className="text-sm font-semibold text-zinc-950">Live Service Logs</span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              connected
                ? 'bg-zinc-950 text-white'
                : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-white' : 'bg-zinc-400'
              }`}
            />
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs (user, group, action)..."
            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowRawJson((r) => !r)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              showRawJson
                ? 'border-zinc-950 bg-zinc-950 text-white'
                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950'
            }`}
          >
            {showRawJson ? 'Raw JSON' : 'Readable'}
          </button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => setLines([])}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>

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
