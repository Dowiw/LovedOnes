'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  MAP_THEME_STORAGE_KEY,
  type MapThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  THEME_CHANGE_EVENT,
} from '@/lib/mapTheme';

export function ThemeToggle() {
  const [pref, setPref] = useState<MapThemePreference>('system');

  useEffect(() => {
    const sync = () => setPref(readStoredThemePreference());
    sync();
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === MAP_THEME_STORAGE_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
    };
  }, []);

  return (
    <div
      role="group"
      aria-label="Theme mode"
      className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-1 text-[11px] font-medium dark:bg-zinc-800"
    >
      {(
        [
          ['system', 'Auto', Monitor],
          ['light', 'Light', Sun],
          ['dark', 'Dark', Moon],
        ] as const
      ).map(([value, label, Icon]) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            title={`Theme: ${label}`}
            onClick={() => {
              setPref(value);
              persistThemePreference(value);
            }}
            className={`flex items-center gap-1 rounded-md px-2 py-1 transition ${
              active
                ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <Icon className="h-3 w-3" />
            <span className="hidden md:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
