import { describe, expect, it } from 'vitest';
import { isIosSafariNeedingInstall, urlBase64ToUint8Array } from '../lib/pwaPush';

describe('PWA & Web Push helpers', () => {
  it('decodes URL-safe base64 VAPID keys into Uint8Array', () => {
    // 65-byte uncompressed P-256 public key in base64url
    const sampleKey =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const bytes = urlBase64ToUint8Array(sampleKey);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it('detects when iOS Safari needs Home Screen installation for Web Push', () => {
    const iphoneUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const androidUa =
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile';

    expect(isIosSafariNeedingInstall(iphoneUa, false)).toBe(true);
    expect(isIosSafariNeedingInstall(iphoneUa, true)).toBe(false);
    expect(isIosSafariNeedingInstall(androidUa, false)).toBe(false);
  });
});
