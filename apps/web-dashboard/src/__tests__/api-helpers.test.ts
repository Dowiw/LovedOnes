import { describe, expect, it } from 'vitest';
import { formatBytes, getLogsWsUrl, getServiceBaseUrls } from '../lib/api';

describe('@loved-ones/web-dashboard helpers', () => {
  it('formats byte counts cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('builds relative gateway paths and log WebSocket URL when unconfigured', () => {
    const urls = getServiceBaseUrls();
    expect(urls).toEqual({ authBase: '', realtimeBase: '', tilesBase: '' });
    expect(getLogsWsUrl('abc')).toBe('/api/admin/logs/stream?token=abc');
  });
});
