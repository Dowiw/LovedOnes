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
    };
  } catch {
    return { raw, msg: raw };
  }
}

function getLevelMeta(level?: number): { label: string; color: string } {
  if (!level || level < 30) return { label: 'DEBUG', color: 'text-slate-400' };
  if (level < 40) return { label: 'INFO ', color: 'text-emerald-400' };
  if (level < 50) return { label: 'WARN ', color: 'text-amber-400' };
  return { label: 'ERROR', color: 'text-rose-400' };
}

interface LiveLogTerminalProps {
  accessToken: string;
}

export function LiveLogTerminal({ accessToken }: LiveLogTerminalProps) {
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [paused, setPaused] = useState(false);
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
    <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold text-white">Live STDOUT & Redis Stream</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              connected
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-emerald-400' : 'bg-slate-500'
              }`}
            />
            {connected ? 'Streaming' : 'Disconnected'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter logs..."
            className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => setLines([])}
            className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>

      <div className="h-80 overflow-y-auto bg-slate-950 p-3 font-mono text-xs leading-5">
        {filtered.length === 0 ? (
          <div className="text-slate-500">Waiting for structured log events on logs:stream...</div>
        ) : (
          filtered.map((item, idx) => {
            const meta = getLevelMeta(item.level);
            return (
              <div key={`${idx}-${item.time ?? ''}`} className="whitespace-pre-wrap break-all py-0.5">
                <span className="text-slate-500">
                  {item.time ? new Date(item.time).toLocaleTimeString() : '--:--:--'}
                </span>{' '}
                <span className={meta.color}>[{meta.label}]</span>{' '}
                {item.service && <span className="text-sky-400">[{item.service}]</span>}{' '}
                <span className="text-slate-200">{item.raw}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
