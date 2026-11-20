'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, LogOut, MapPin, QrCode } from 'lucide-react';
import { isSafeAvatarUrl } from '@loved-ones/shared';
import { AuthUser } from '@/lib/api';

interface NavBarProps {
  user: AuthUser | null;
  onSignOut: () => void;
}

export function NavBar({ user, onSignOut }: NavBarProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 px-4 pt-3 sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between rounded-full border border-slate-200/80 bg-white/85 px-4 py-2 shadow-[0_8px_28px_rgba(15,23,42,0.06)] backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-950 text-white">
              <MapPin className="h-4 w-4" />
            </span>
            <span>LovedOnes</span>
          </Link>

          <nav className="flex items-center gap-1 rounded-full bg-slate-100/90 p-1 text-xs font-medium">
            <Link
              href="/"
              className={`rounded-full px-3 py-1.5 transition ${
                pathname === '/'
                  ? 'bg-zinc-900 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              Live Map
            </Link>
            {user?.role === 'HOST_ADMIN' && (
              <>
                <Link
                  href="/admin"
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition ${
                    pathname === '/admin'
                      ? 'bg-zinc-900 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <Activity className="h-3.5 w-3.5" />
                  Telemetry
                </Link>
                <Link
                  href="/admin/invites"
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition ${
                    pathname === '/admin/invites'
                      ? 'bg-zinc-900 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <QrCode className="h-3.5 w-3.5" />
                  Invites
                </Link>
              </>
            )}
          </nav>
        </div>

        {user && (
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs sm:flex">
              <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-zinc-900 text-[10px] font-bold text-white">
                {isSafeAvatarUrl(user.avatarUrl) ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.username}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  user.username.slice(0, 1).toUpperCase()
                )}
              </span>
              <span className="font-medium text-zinc-900">{user.username}</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                {user.role === 'HOST_ADMIN' ? 'Admin' : 'Member'}
              </span>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              title="Sign out"
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-slate-50 hover:text-zinc-950"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
