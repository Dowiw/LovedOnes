export type MobileNavOs = 'android' | 'ios' | 'desktop';

export interface ViewportSnapshot {
  innerWidth: number;
  innerHeight: number;
  visualViewportHeight?: number | null;
  visualViewportOffsetTop?: number | null;
  userAgent?: string;
  coarsePointer?: boolean;
  isStandalone?: boolean;
}

export interface MobileViewportMetrics {
  appHeight: number;
  keyboardInset: number;
  isMobile: boolean;
  os: MobileNavOs;
}

const KEYBOARD_THRESHOLD_PX = 100;

/**
 * Detects the host OS navigation environment from User-Agent and pointer/viewport traits.
 */
export function detectMobileNavOs(
  userAgent = '',
  innerWidth = 1024,
  coarsePointer = false,
): MobileNavOs {
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (coarsePointer && innerWidth < 1024) return 'android';
  return 'desktop';
}

/**
 * Computes the visible application height and keyboard inset so fixed/absolute
 * controls stay strictly above mobile browser toolbars, OS navigation bars, and keyboards.
 */
export function computeMobileViewportMetrics(snapshot: ViewportSnapshot): MobileViewportMetrics {
  const innerHeight = Math.max(200, Math.round(snapshot.innerHeight || 0));
  const rawVisualHeight = snapshot.visualViewportHeight;
  const hasVisualHeight =
    typeof rawVisualHeight === 'number' &&
    Number.isFinite(rawVisualHeight) &&
    rawVisualHeight > 120;
  const visualHeight = hasVisualHeight ? Math.round(rawVisualHeight) : innerHeight;
  const offsetTop =
    typeof snapshot.visualViewportOffsetTop === 'number' &&
    Number.isFinite(snapshot.visualViewportOffsetTop)
      ? Math.max(0, Math.round(snapshot.visualViewportOffsetTop))
      : 0;

  const os = detectMobileNavOs(
    snapshot.userAgent ?? '',
    snapshot.innerWidth,
    Boolean(snapshot.coarsePointer),
  );
  const isMobile =
    os !== 'desktop' || Boolean(snapshot.coarsePointer) || snapshot.innerWidth < 768;

  const delta = Math.max(0, innerHeight - (visualHeight + offsetTop));
  const keyboardInset = isMobile && delta >= KEYBOARD_THRESHOLD_PX ? delta : 0;

  // Use visualViewport height when smaller than innerHeight (e.g. keyboard or browser bar)
  // while ignoring minor pinch-zoom noise on desktop.
  const appHeight = isMobile ? Math.min(innerHeight, visualHeight) : innerHeight;

  return {
    appHeight: Math.max(200, appHeight),
    keyboardInset,
    isMobile,
    os,
  };
}
