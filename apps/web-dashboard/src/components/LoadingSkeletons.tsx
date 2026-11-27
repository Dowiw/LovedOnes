'use client';

import { Loader2 } from 'lucide-react';

export interface LoadingInlineBadgeProps {
  label: string;
  className?: string;
}

/**
 * Compact monochrome spinner + label for non-blocking background or first-open loading states.
 */
export function LoadingInlineBadge({ label, className = '' }: LoadingInlineBadgeProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 ${className}`}
    >
      <Loader2 className="h-3 w-3 animate-spin text-zinc-600 dark:text-zinc-300" />
      <span>{label}</span>
    </span>
  );
}

export interface LoadingListSkeletonProps {
  rows?: number;
  variant?: 'people' | 'chat' | 'places' | 'compact' | 'trips';
  label?: string;
}

/**
 * Monochrome light/dark skeleton list shown while uncached panels resolve their initial fetch.
 */
export function LoadingListSkeleton({
  rows = 3,
  variant = 'compact',
  label,
}: LoadingListSkeletonProps) {
  const items = Array.from({ length: Math.max(1, rows) });

  return (
    <div role="status" aria-live="polite" className="space-y-2">
      {label && (
        <div className="flex items-center justify-center py-1">
          <LoadingInlineBadge label={label} />
        </div>
      )}

      {items.map((_, idx) => {
        if (variant === 'people') {
          return (
            <div
              key={idx}
              className="flex animate-pulse items-center justify-between gap-2.5 rounded-lg border border-zinc-100 bg-zinc-50/75 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/50"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <div className="h-8 w-8 shrink-0 rounded-full bg-zinc-200/90 dark:bg-zinc-700/80" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-24 rounded bg-zinc-200/90 dark:bg-zinc-700/80" />
                  <div className="h-2.5 w-32 rounded bg-zinc-200/70 dark:bg-zinc-700/60" />
                </div>
              </div>
              <div className="h-5 w-12 shrink-0 rounded-full bg-zinc-200/80 dark:bg-zinc-700/70" />
            </div>
          );
        }

        if (variant === 'chat') {
          const alignRight = idx % 2 === 1;
          return (
            <div
              key={idx}
              className={`flex animate-pulse flex-col gap-1 ${
                alignRight ? 'items-end' : 'items-start'
              }`}
            >
              <div className="h-2 w-20 rounded bg-zinc-200/80 dark:bg-zinc-700/70" />
              <div
                className={`h-8 rounded-lg ${
                  alignRight
                    ? 'w-3/5 bg-zinc-300/80 dark:bg-zinc-700/80'
                    : 'w-4/5 bg-zinc-200/80 dark:bg-zinc-800'
                }`}
              />
            </div>
          );
        }

        if (variant === 'places' || variant === 'trips') {
          return (
            <div
              key={idx}
              className="animate-pulse space-y-2 rounded-lg border border-zinc-200/70 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/55"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="h-3 w-28 rounded bg-zinc-200/90 dark:bg-zinc-700/80" />
                <div className="h-4 w-14 rounded-full bg-zinc-200/75 dark:bg-zinc-700/65" />
              </div>
              <div className="h-2.5 w-3/4 rounded bg-zinc-200/70 dark:bg-zinc-700/60" />
            </div>
          );
        }

        return (
          <div
            key={idx}
            className="animate-pulse rounded-lg border border-zinc-200/70 bg-zinc-50/80 px-2.5 py-2 dark:border-zinc-800 dark:bg-zinc-800/55"
          >
            <div className="h-2.5 w-2/3 rounded bg-zinc-200/90 dark:bg-zinc-700/80" />
            <div className="mt-1.5 h-2 w-1/2 rounded bg-zinc-200/70 dark:bg-zinc-700/60" />
          </div>
        );
      })}
    </div>
  );
}
