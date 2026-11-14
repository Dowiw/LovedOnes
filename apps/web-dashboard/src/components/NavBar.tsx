'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, LogOut, MapPin, QrCode, Shield } from 'lucide-react';
import { AuthUser } from '@/lib/api';

interface NavBarProps {
  user: AuthUser | null;
  onSignOut: () => void;
}

export function NavBar({ user, onSignOut }: NavBarProps) {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
              <MapPin className="h-4 w-4" />
            </span>
            <span>LovedOnes</span>
          </Link>

          <nav className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              className={`rounded-md px-3 py-1.5 transition ${
                pathname === '/'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              Live Map & Chat
            </Link>
            {user?.role === 'HOST_ADMIN' && (
              <>
                <Link
                  href="/admin"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition ${
                    pathname === '/admin'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  <Activity className="h-3.5 w-3.5 text-emerald-400" />
                  Admin Telemetry
                </Link>
                <Link
                  href="/admin/invites"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition ${
                    pathname === '/admin/invites'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  <QrCode className="h-3.5 w-3.5 text-sky-400" />
                  QR Invites
                </Link>
              </>
            )}
          </nav>
        </div>

        {user && (
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1 text-xs sm:flex">
              <Shield className="h-3.5 w-3.5 text-emerald-400" />
              <span className="font-medium text-slate-200">{user.username}</span>
              <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">
                {user.role}
              </span>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
