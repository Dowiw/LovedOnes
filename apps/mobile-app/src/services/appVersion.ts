import {
  AppVersionInfoSchema,
  DEFAULT_APP_VERSION,
  type AppPlatform,
  type AppVersionInfo,
} from '@loved-ones/shared';
import appConfig from '../../app.json';

export const INSTALLED_APP_VERSION: string =
  appConfig?.expo?.version ?? DEFAULT_APP_VERSION;

/**
 * Queries the connected LovedOnes server for whether a newer mobile release
 * (APK/IPA) is available or required relative to the installed binary version.
 */
export async function checkMobileAppVersion(
  serverUrl: string,
  currentVersion: string = INSTALLED_APP_VERSION,
  platform: AppPlatform = 'android',
  fetchImpl: typeof fetch = fetch,
): Promise<AppVersionInfo | null> {
  const cleanServer = serverUrl.trim().replace(/\/$/, '');
  if (!cleanServer) return null;

  const qs = `platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(currentVersion)}`;
  const res = await fetchImpl(`${cleanServer}/api/auth/app-version?${qs}`, {
    headers: { 'X-App-Version': currentVersion },
  });
  if (!res.ok) return null;

  const parsed = AppVersionInfoSchema.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

export function formatAppUpdateNotice(
  info: AppVersionInfo,
  installedVersion: string = INSTALLED_APP_VERSION,
): { title: string; body: string } {
  const title = info.updateRequired
    ? `App update required · v${info.latestMobileVersion}`
    : `App update available · v${info.latestMobileVersion}`;
  const body = `Server updated (installed v${installedVersion}). Download latest build to stay in sync.`;
  return { title, body };
}
