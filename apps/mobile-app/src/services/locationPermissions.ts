export type LocationPermissionLevel = 'always' | 'foreground' | 'denied';

export interface LocationPermissionResult {
  level: LocationPermissionLevel;
  canAskAgain: boolean;
  label: string;
}

export interface LocationPermissionAdapter {
  requestForegroundPermissionsAsync(): Promise<{ status: string; canAskAgain?: boolean }>;
  requestBackgroundPermissionsAsync(): Promise<{ status: string; canAskAgain?: boolean }>;
}

async function getDefaultLocationAdapter(): Promise<LocationPermissionAdapter> {
  const Location = await import('expo-location');
  return Location;
}

/**
 * Requests foreground and background location permissions in sequence (required by
 * both Android 11+ and standalone iOS builds). If the user grants "While Using the App"
 * but denies "Always Allow", resolves cleanly to `'foreground'` instead of throwing.
 */
export async function requestLocationPermissionsOnLaunch(
  adapter?: LocationPermissionAdapter,
): Promise<LocationPermissionResult> {
  const loc = adapter ?? (await getDefaultLocationAdapter());
  const fg = await loc.requestForegroundPermissionsAsync();

  if (fg.status !== 'granted') {
    return {
      level: 'denied',
      canAskAgain: Boolean(fg.canAskAgain ?? true),
      label: 'Location Permission Denied — Tap to Grant',
    };
  }

  try {
    const bg = await loc.requestBackgroundPermissionsAsync();
    if (bg.status === 'granted') {
      return {
        level: 'always',
        canAskAgain: true,
        label: 'Location Permission: Always Allow',
      };
    }
    return {
      level: 'foreground',
      canAskAgain: Boolean(bg.canAskAgain ?? true),
      label: 'Location Permission: While Using App (Foreground Fallback)',
    };
  } catch {
    return {
      level: 'foreground',
      canAskAgain: true,
      label: 'Location Permission: While Using App (Foreground Fallback)',
    };
  }
}
