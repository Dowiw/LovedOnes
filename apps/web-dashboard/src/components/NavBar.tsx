'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, LogOut, QrCode } from 'lucide-react';
import { isSafeAvatarUrl } from '@loved-ones/shared';
import { BrandMark } from '@/components/BrandMark';
import { AuthUser } from '@/lib/api';

interface NavBarProps {
  user: AuthUser | null;
  onSignOut: () => void;
}

export function NavBar({ user, onSignOut }: NavBarProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 pl-[calc(1rem+var(--lo-safe-left,0px))] pr-[calc(1rem+var(--lo-safe-right,0px))] pt-[calc(0.75rem+var(--lo-safe-top,0px))] sm:pl-[calc(1.5rem+var(--lo-safe-left,0px))] sm:pr-[calc(1.5rem+var(--lo-safe-right,0px))]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200/80 bg-white/90 px-3 py-2 shadow-[0_8px_28px_rgba(9,9,11,0.06)] backdrop-blur-xl sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-sm font-bold tracking-tight text-zinc-950">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-950 text-white">
              <BrandMark className="h-5 w-5" />
            </span>
            <span className="hidden xs:inline sm:inline">LovedOnes</span>
          </Link>

          <nav className="flex items-center gap-1 overflow-x-auto rounded-lg bg-zinc-100 p-1 text-xs font-medium">
            <Link
              href="/"
              className={`rounded-md px-3 py-1.5 transition ${
                pathname === '/'
                  ? 'bg-zinc-950 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-950'
              }`}
            >
              Live Map
            </Link>
            {user?.role === 'HOST_ADMIN' && (
              <>
                <Link
                  href="/admin"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition ${
                    pathname === '/admin'
                      ? 'bg-zinc-950 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-950'
                  }`}
                >
                  <Activity className="h-3.5 w-3.5" />
                  Telemetry
                </Link>
                <Link
                  href="/admin/invites"
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition ${
                    pathname === '/admin/invites'
                      ? 'bg-zinc-950 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-950'
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
            <div className="hidden items-center gap-2 rounded-lg border border-zinc-200/70 bg-zinc-50 px-2.5 py-1 text-xs sm:flex">
              <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-zinc-950 text-[10px] font-bold text-white">
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
              <span className="font-medium text-zinc-950">{user.username}</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                {user.role === 'HOST_ADMIN' ? 'Admin' : 'Member'}
              </span>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              title="Sign out"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950"
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
