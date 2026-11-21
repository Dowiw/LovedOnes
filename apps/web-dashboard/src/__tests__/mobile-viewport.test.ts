import { describe, expect, it } from 'vitest';
import { computeMobileViewportMetrics, detectMobileNavOs } from '../lib/mobileViewport';

describe('mobile browser viewport & navigation bar awareness', () => {
  it('detects Android, iOS, and desktop navigation environments', () => {
    expect(
      detectMobileNavOs(
        'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile',
        412,
        true,
      ),
    ).toBe('android');
    expect(
      detectMobileNavOs(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        390,
        true,
      ),
    ).toBe('ios');
    expect(
      detectMobileNavOs(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        1440,
        false,
      ),
    ).toBe('desktop');
  });

  it('tracks visible dynamic height below top browser chrome and above Android nav bar', () => {
    const metrics = computeMobileViewportMetrics({
      innerWidth: 384,
      innerHeight: 732,
      visualViewportHeight: 732,
      visualViewportOffsetTop: 0,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/131.0.0.0 Mobile',
      coarsePointer: true,
    });

    expect(metrics).toEqual({
      appHeight: 732,
      keyboardInset: 0,
      isMobile: true,
      os: 'android',
    });
  });

  it('computes keyboard inset and shrinks appHeight when mobile soft keyboard opens', () => {
    const metrics = computeMobileViewportMetrics({
      innerWidth: 390,
      innerHeight: 740,
      visualViewportHeight: 452,
      visualViewportOffsetTop: 0,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
      coarsePointer: true,
    });

    expect(metrics).toEqual({
      appHeight: 452,
      keyboardInset: 288,
      isMobile: true,
      os: 'ios',
    });
  });

  it('keeps desktop innerHeight unaffected by minor zoom changes', () => {
    const metrics = computeMobileViewportMetrics({
      innerWidth: 1280,
      innerHeight: 800,
      visualViewportHeight: 760,
      visualViewportOffsetTop: 0,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0',
      coarsePointer: false,
    });

    expect(metrics).toEqual({
      appHeight: 800,
      keyboardInset: 0,
      isMobile: false,
      os: 'desktop',
    });
  });
});
