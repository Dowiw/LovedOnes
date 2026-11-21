'use client';

import { useEffect } from 'react';
import { computeMobileViewportMetrics } from '@/lib/mobileViewport';

/**
 * Keeps CSS custom properties (`--lo-app-height`, `--lo-keyboard-inset`) synchronized
 * with the live mobile browser viewport so overlays stay above Android/iOS system navigation bars.
 */
export function MobileViewportSync() {
  useEffect(() => {
    const root = document.documentElement;
    const coarseQuery = window.matchMedia?.('(pointer: coarse)');
    const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');

    const sync = () => {
      const vv = window.visualViewport;
      const metrics = computeMobileViewportMetrics({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        visualViewportHeight: vv?.height ?? null,
        visualViewportOffsetTop: vv?.offsetTop ?? null,
        userAgent: navigator.userAgent,
        coarsePointer: coarseQuery?.matches ?? false,
        isStandalone: standaloneQuery?.matches ?? false,
      });

      root.style.setProperty('--lo-app-height', `${metrics.appHeight}px`);
      root.style.setProperty('--lo-keyboard-inset', `${metrics.keyboardInset}px`);
      root.dataset.mobileOs = metrics.os;
      root.dataset.mobileKeyboard = metrics.keyboardInset > 0 ? 'open' : 'closed';
    };

    sync();

    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('orientationchange', sync, { passive: true });
    window.visualViewport?.addEventListener('resize', sync, { passive: true });
    window.visualViewport?.addEventListener('scroll', sync, { passive: true });

    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      window.visualViewport?.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('scroll', sync);
    };
  }, []);

  return null;
}
