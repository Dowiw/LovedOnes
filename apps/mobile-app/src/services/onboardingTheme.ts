export type OnboardingColorScheme = 'light' | 'dark';

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
  badgeSuccessBg: string;
  badgeSuccessBorder: string;
  badgeSuccessText: string;
  badgeSuccessDot: string;
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
  pulseRing: 'rgba(24, 24, 27, 0.14)',
  badgeSuccessBg: '#ecfdf5',
  badgeSuccessBorder: '#a7f3d0',
  badgeSuccessText: '#065f46',
  badgeSuccessDot: '#10b981',
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
  pulseRing: 'rgba(250, 250, 250, 0.18)',
  badgeSuccessBg: 'rgba(16, 185, 129, 0.14)',
  badgeSuccessBorder: 'rgba(52, 211, 153, 0.34)',
  badgeSuccessText: '#6ee7b7',
  badgeSuccessDot: '#34d399',
  noticeBg: '#27272a',
  noticeBorder: '#3f3f46',
  noticeText: '#fafafa',
  errorBg: 'rgba(244, 63, 94, 0.14)',
  errorBorder: 'rgba(251, 113, 133, 0.34)',
  errorText: '#fda4af',
};

/**
 * Returns monochrome palette tokens matching the OS Light/Dark color scheme.
 */
export function getOnboardingPalette(scheme: 'light' | 'dark' | null | undefined): OnboardingPalette {
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
 * Returns a sensible local dev fallback URL when no server has been bound yet.
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
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return 'Please enter a valid email address.';
  }
  if (input.mode === 'register') {
    const cleanName = input.username.trim();
    if (cleanName.length < 1) {
      return 'Enter a display name so your circle recognizes you.';
    }
    if (input.password.length < 8) {
      return 'Use a password with at least 8 characters.';
    }
  } else if (!input.password) {
    return 'Please enter your password.';
  }
  return null;
}
