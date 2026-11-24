export type OnboardingColorScheme = 'light' | 'dark';

export const ONBOARDING_COLOR_PRESETS = [
  { label: 'Amber', hex: '#f59e0b' },
  { label: 'Sky', hex: '#0ea5e9' },
  { label: 'Emerald', hex: '#10b981' },
  { label: 'Violet', hex: '#8b5cf6' },
  { label: 'Rose', hex: '#f43f5e' },
  { label: 'Ink', hex: '#18181b' },
] as const;

export interface GeometricFontFamily {
  display: string;
  heading: string;
  body: string;
  mono: string;
}

export interface OnboardingPalette {
  scheme: OnboardingColorScheme;
  statusBarStyle: 'dark' | 'light';
  canvas: string;
  surface: string;
  surfaceMuted: string;
  surfaceChip: string;
  border: string;
  borderStrong: string;
  borderFocus: string;
  ink: string;
  inkMuted: string;
  inkSubtle: string;
  placeholder: string;
  ctaBg: string;
  ctaText: string;
  secondaryBg: string;
  secondaryBorder: string;
  secondaryText: string;
  orbBg: string;
  pulseRing: string;
  electricGlow: string;
  badgeSuccessBg: string;
  badgeSuccessBorder: string;
  badgeSuccessText: string;
  badgeSuccessDot: string;
  badgeWarnBg: string;
  badgeWarnBorder: string;
  badgeWarnText: string;
  noticeBg: string;
  noticeBorder: string;
  noticeText: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
}

const LIGHT_PALETTE: OnboardingPalette = {
  scheme: 'light',
  statusBarStyle: 'dark',
  canvas: '#f4f4f5',
  surface: '#ffffff',
  surfaceMuted: '#fafafa',
  surfaceChip: '#f4f4f5',
  border: '#e4e4e7',
  borderStrong: '#d4d4d8',
  borderFocus: '#18181b',
  ink: '#18181b',
  inkMuted: '#71717a',
  inkSubtle: '#52525b',
  placeholder: '#a1a1aa',
  ctaBg: '#18181b',
  ctaText: '#ffffff',
  secondaryBg: '#ffffff',
  secondaryBorder: '#e4e4e7',
  secondaryText: '#18181b',
  orbBg: 'rgba(24, 24, 27, 0.045)',
  pulseRing: 'rgba(24, 24, 27, 0.16)',
  electricGlow: '#0ea5e9',
  badgeSuccessBg: '#ecfdf5',
  badgeSuccessBorder: '#a7f3d0',
  badgeSuccessText: '#065f46',
  badgeSuccessDot: '#10b981',
  badgeWarnBg: '#fffbeb',
  badgeWarnBorder: '#fde68a',
  badgeWarnText: '#92400e',
  noticeBg: '#f4f4f5',
  noticeBorder: '#e4e4e7',
  noticeText: '#18181b',
  errorBg: '#fff1f2',
  errorBorder: '#fecdd3',
  errorText: '#be123c',
};

const DARK_PALETTE: OnboardingPalette = {
  scheme: 'dark',
  statusBarStyle: 'light',
  canvas: '#09090b',
  surface: '#18181b',
  surfaceMuted: '#27272a',
  surfaceChip: '#27272a',
  border: '#27272a',
  borderStrong: '#3f3f46',
  borderFocus: '#fafafa',
  ink: '#fafafa',
  inkMuted: '#a1a1aa',
  inkSubtle: '#d4d4d8',
  placeholder: '#71717a',
  ctaBg: '#fafafa',
  ctaText: '#09090b',
  secondaryBg: '#18181b',
  secondaryBorder: '#3f3f46',
  secondaryText: '#fafafa',
  orbBg: 'rgba(250, 250, 250, 0.05)',
  pulseRing: 'rgba(250, 250, 250, 0.2)',
  electricGlow: '#38bdf8',
  badgeSuccessBg: 'rgba(16, 185, 129, 0.14)',
  badgeSuccessBorder: 'rgba(52, 211, 153, 0.34)',
  badgeSuccessText: '#6ee7b7',
  badgeSuccessDot: '#34d399',
  badgeWarnBg: 'rgba(245, 158, 11, 0.14)',
  badgeWarnBorder: 'rgba(251, 191, 36, 0.34)',
  badgeWarnText: '#fcd34d',
  noticeBg: '#27272a',
  noticeBorder: '#3f3f46',
  noticeText: '#fafafa',
  errorBg: 'rgba(244, 63, 94, 0.14)',
  errorBorder: 'rgba(251, 113, 133, 0.34)',
  errorText: '#fda4af',
};

/**
 * Returns spatial geometric font families available natively on iOS and Android
 * without requiring native font asset rebuilds.
 */
export function getGeometricFonts(platformOs: string): GeometricFontFamily {
  if (platformOs === 'ios') {
    return {
      display: 'AvenirNext-DemiBold',
      heading: 'AvenirNext-Medium',
      body: 'Avenir Next',
      mono: 'Menlo',
    };
  }
  return {
    display: 'sans-serif-medium',
    heading: 'sans-serif-medium',
    body: 'sans-serif',
    mono: 'monospace',
  };
}

/**
 * Returns monochrome palette tokens matching the OS Light/Dark color scheme.
 */
export function getOnboardingPalette(
  scheme: 'light' | 'dark' | null | undefined,
): OnboardingPalette {
  return scheme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Formats a full server URL into a calm host label for chips and summaries.
 */
export function formatServerHostLabel(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/$/, '');
  if (!trimmed) return 'Not configured';
  try {
    const parsed = new URL(trimmed);
    return parsed.host || trimmed;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '');
  }
}

/**
 * Returns a sensible local dev fallback URL when running in dev mode.
 */
export function getDefaultServerUrl(platformOs: string): string {
  return platformOs === 'ios' ? 'http://localhost:8080' : 'http://localhost:8080';
}

export interface AuthFormValidationInput {
  mode: 'login' | 'register';
  serverUrl: string;
  email: string;
  username: string;
  password: string;
}

/**
 * Validates login/registration fields locally with friendly messages before hitting the API.
 */
export function validateAuthForm(input: AuthFormValidationInput): string | null {
  const cleanServer = input.serverUrl.trim().replace(/\/$/, '');
  if (!cleanServer || !/^https?:\/\/.+/i.test(cleanServer)) {
    return 'Check your server address (for example, https://track.example.com).';
  }
  const cleanEmail = input.email.trim();
  if (input.mode === 'register') {
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return 'Please enter a valid email address.';
    }
    const cleanName = input.username.trim();
    if (cleanName.length < 2) {
      return 'Enter a username with at least 2 characters.';
    }
    if (cleanName.includes('@')) {
      return 'Username cannot contain "@".';
    }
    if (input.password.length < 8) {
      return 'Use a password with at least 8 characters.';
    }
  } else {
    if (!cleanEmail) {
      return 'Please enter your email or username.';
    }
    if (!input.password) {
      return 'Please enter your password.';
    }
  }
  return null;
}

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const safeH = ((h % 360) + 360) % 360;
  const safeS = Math.max(0, Math.min(1, s));
  const safeV = Math.max(0, Math.min(1, v));
  const c = safeV * safeS;
  const x = c * (1 - Math.abs(((safeH / 60) % 2) - 1));
  const m = safeV - c;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (safeH < 60) {
    r1 = c;
    g1 = x;
  } else if (safeH < 120) {
    r1 = x;
    g1 = c;
  } else if (safeH < 180) {
    g1 = c;
    b1 = x;
  } else if (safeH < 240) {
    g1 = x;
    b1 = c;
  } else if (safeH < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

export function hexToHsv(rawHex: string): HsvColor {
  const clean = rawHex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return { h: 199, s: 0.94, v: 0.91 };
  }
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}
