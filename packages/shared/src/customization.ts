import { z } from 'zod';
import { hexToRgba, HexColorSchema, type TrailActivityMode } from './schemas.js';

export type InterfacePresetId =
  | 'default'
  | 'pink'
  | 'red'
  | 'navy'
  | 'sky'
  | 'emerald'
  | 'violet'
  | 'amber';

export type InterfaceThemeMode = 'preset' | 'custom';
export type SurfaceWashLevel = 'off' | 'subtle' | 'bold';
export type ActivityPaletteGroupId =
  | 'default'
  | 'colorblind'
  | 'neon'
  | 'pastel'
  | 'earthy'
  | 'custom';
export type CornerStyleOption = 'crisp' | 'balanced' | 'soft';
export type DensityOption = 'comfortable' | 'compact';
export type ChatBubbleStyleOption = 'accent' | 'tinted';

export const USER_CUSTOMIZATION_STORAGE_PREFIX = 'lovedones:custom-prefs:v1:';

export const InterfacePresetSchema = z.enum([
  'default',
  'pink',
  'red',
  'navy',
  'sky',
  'emerald',
  'violet',
  'amber',
]);

export const ActivityColorsRecordSchema = z.object({
  stationary: HexColorSchema,
  walking: HexColorSchema,
  running: HexColorSchema,
  cycling: HexColorSchema,
  transit: HexColorSchema,
  driving: HexColorSchema,
});

export type ActivityColorsMap = z.infer<typeof ActivityColorsRecordSchema>;

export const UserCustomizationSchema = z.object({
  version: z.literal(1).default(1),
  themeMode: z.enum(['preset', 'custom']).default('preset'),
  interfacePreset: InterfacePresetSchema.default('default'),
  surfaceWash: z.enum(['off', 'subtle', 'bold']).default('subtle'),
  customInterface: z
    .object({
      hue: z.number().min(0).max(360).default(330),
      saturation: z.number().min(10).max(100).default(78),
      lightness: z.number().min(20).max(74).default(48),
    })
    .default({}),
  activityPaletteId: z
    .enum(['default', 'colorblind', 'neon', 'pastel', 'earthy', 'custom'])
    .default('default'),
  customActivityColors: ActivityColorsRecordSchema.default({
    stationary: '#64748b',
    walking: '#10b981',
    running: '#f97316',
    cycling: '#8b5cf6',
    transit: '#06b6d4',
    driving: '#2563eb',
  }),
  mapAccents: z
    .object({
      groupPlaceColor: HexColorSchema.default('#0d9488'),
      privatePlaceColor: HexColorSchema.default('#4f46e5'),
      fallbackTrailColor: z.union([z.literal('auto'), HexColorSchema]).default('auto'),
      chatBubbleStyle: z.enum(['accent', 'tinted']).default('accent'),
    })
    .default({}),
  visualStyle: z
    .object({
      cornerStyle: z.enum(['crisp', 'balanced', 'soft']).default('balanced'),
      density: z.enum(['comfortable', 'compact']).default('comfortable'),
      glassBlur: z.boolean().default(true),
      reducedMotion: z.boolean().default(false),
    })
    .default({}),
});

export type UserCustomization = z.infer<typeof UserCustomizationSchema>;

export const DEFAULT_USER_CUSTOMIZATION: UserCustomization = UserCustomizationSchema.parse({});

export interface InterfacePresetDefinition {
  id: InterfacePresetId;
  label: string;
  swatchHex: string;
  hue: number;
  saturation: number;
  lightness: number;
  darkAccentHex?: string;
}

export const INTERFACE_THEME_PRESETS: readonly InterfacePresetDefinition[] = [
  {
    id: 'default',
    label: 'Monochrome',
    swatchHex: '#18181b',
    hue: 240,
    saturation: 5,
    lightness: 10,
  },
  {
    id: 'pink',
    label: 'Pink',
    swatchHex: '#ec4899',
    hue: 330,
    saturation: 81,
    lightness: 52,
    darkAccentHex: '#f472b6',
  },
  {
    id: 'red',
    label: 'Red',
    swatchHex: '#e11d48',
    hue: 347,
    saturation: 77,
    lightness: 47,
    darkAccentHex: '#fb7185',
  },
  {
    id: 'navy',
    label: 'Navy Blue',
    swatchHex: '#1e3a8a',
    hue: 224,
    saturation: 64,
    lightness: 33,
    darkAccentHex: '#60a5fa',
  },
  {
    id: 'sky',
    label: 'Sky Blue',
    swatchHex: '#0284c7',
    hue: 199,
    saturation: 89,
    lightness: 41,
    darkAccentHex: '#38bdf8',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    swatchHex: '#059669',
    hue: 160,
    saturation: 84,
    lightness: 36,
    darkAccentHex: '#34d399',
  },
  {
    id: 'violet',
    label: 'Violet',
    swatchHex: '#7c3aed',
    hue: 263,
    saturation: 78,
    lightness: 54,
    darkAccentHex: '#a78bfa',
  },
  {
    id: 'amber',
    label: 'Amber',
    swatchHex: '#d97706',
    hue: 32,
    saturation: 95,
    lightness: 44,
    darkAccentHex: '#fbbf24',
  },
] as const;

export interface ActivityPaletteGroupDefinition {
  id: Exclude<ActivityPaletteGroupId, 'custom'>;
  label: string;
  description: string;
  colors: ActivityColorsMap;
}

export const ACTIVITY_PALETTE_GROUPS: readonly ActivityPaletteGroupDefinition[] = [
  {
    id: 'default',
    label: 'Default Signal',
    description: 'High-clarity map signal colors',
    colors: {
      stationary: '#64748b',
      walking: '#10b981',
      running: '#f97316',
      cycling: '#8b5cf6',
      transit: '#06b6d4',
      driving: '#2563eb',
    },
  },
  {
    id: 'colorblind',
    label: 'Colorblind Safe',
    description: 'Okabe-Ito perceptual palette',
    colors: {
      stationary: '#71717a',
      walking: '#009e73',
      running: '#e69f00',
      cycling: '#cc79a7',
      transit: '#56b4e9',
      driving: '#0072b2',
    },
  },
  {
    id: 'neon',
    label: 'Neon Night',
    description: 'Luminous tones for dark maps',
    colors: {
      stationary: '#94a3b8',
      walking: '#22c55e',
      running: '#fb7185',
      cycling: '#e879f9',
      transit: '#22d3ee',
      driving: '#facc15',
    },
  },
  {
    id: 'pastel',
    label: 'Pastel Editorial',
    description: 'Soft muted hues for daylight maps',
    colors: {
      stationary: '#a8a29e',
      walking: '#34d399',
      running: '#fb923c',
      cycling: '#a78bfa',
      transit: '#2dd4bf',
      driving: '#60a5fa',
    },
  },
  {
    id: 'earthy',
    label: 'Earthy Topo',
    description: 'Warm trail & topographic tones',
    colors: {
      stationary: '#78716c',
      walking: '#65a30d',
      running: '#c2410c',
      cycling: '#b45309',
      transit: '#0f766e',
      driving: '#1d4ed8',
    },
  },
] as const;

export function hslToHex(h: number, s: number, l: number): string {
  const safeH = ((h % 360) + 360) % 360;
  const safeS = Math.max(0, Math.min(100, s)) / 100;
  const safeL = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * safeL - 1)) * safeS;
  const x = c * (1 - Math.abs(((safeH / 60) % 2) - 1));
  const m = safeL - c / 2;

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

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

export function getRelativeLuminance(hex: string): number {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 0;
  const channels = [0, 2, 4].map((idx) => {
    const srgb = Number.parseInt(clean.slice(idx, idx + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Picks high-contrast foreground text (#ffffff vs #09090b) against a solid fill color.
 */
export function pickContrastForeground(backgroundHex: string): '#ffffff' | '#09090b' {
  const lum = getRelativeLuminance(backgroundHex);
  return lum > 0.36 ? '#09090b' : '#ffffff';
}

export interface ResolvedInterfaceTokens {
  isDefaultMonochrome: boolean;
  accentBg: string;
  accentFg: '#ffffff' | '#09090b';
  accentHoverBg: string;
  accentSoftBg: string;
  accentSoftText: string;
  accentBorder: string;
  surfaceBg: string;
  surfaceMutedBg: string;
  canvasBg: string;
  borderColor: string;
  glowColor: string;
  cornerPx: {
    card: number;
    control: number;
    pill: number;
  };
}

export function resolveInterfaceThemeTokens(
  prefs: UserCustomization,
  scheme: 'light' | 'dark',
): ResolvedInterfaceTokens {
  const isDark = scheme === 'dark';
  const cornerPx =
    prefs.visualStyle.cornerStyle === 'crisp'
      ? { card: 8, control: 6, pill: 8 }
      : prefs.visualStyle.cornerStyle === 'soft'
        ? { card: 18, control: 12, pill: 999 }
        : { card: 12, control: 8, pill: 999 };

  if (prefs.themeMode === 'preset' && prefs.interfacePreset === 'default') {
    return {
      isDefaultMonochrome: true,
      accentBg: isDark ? '#f4f4f5' : '#18181b',
      accentFg: isDark ? '#09090b' : '#ffffff',
      accentHoverBg: isDark ? '#e4e4e7' : '#27272a',
      accentSoftBg: isDark ? 'rgba(244, 244, 245, 0.12)' : 'rgba(24, 24, 27, 0.08)',
      accentSoftText: isDark ? '#fafafa' : '#18181b',
      accentBorder: isDark ? '#3f3f46' : '#e4e4e7',
      surfaceBg: isDark ? 'rgba(24, 24, 27, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      surfaceMutedBg: isDark ? '#27272a' : '#fafafa',
      canvasBg: isDark ? '#09090b' : '#f4f4f5',
      borderColor: isDark ? '#27272a' : '#e4e4e7',
      glowColor: isDark ? '#38bdf8' : '#0ea5e9',
      cornerPx,
    };
  }

  const presetDef =
    prefs.themeMode === 'preset'
      ? INTERFACE_THEME_PRESETS.find((p) => p.id === prefs.interfacePreset) ??
        INTERFACE_THEME_PRESETS[1]
      : null;

  const hue = presetDef ? presetDef.hue : prefs.customInterface.hue;
  const sat = presetDef ? presetDef.saturation : prefs.customInterface.saturation;
  const light = presetDef ? presetDef.lightness : prefs.customInterface.lightness;

  const accentBg = presetDef
    ? isDark
      ? presetDef.darkAccentHex ?? hslToHex(hue, Math.min(95, sat), Math.min(72, light + 16))
      : presetDef.swatchHex
    : isDark
      ? hslToHex(hue, Math.min(94, sat), Math.min(72, Math.max(52, light + 12)))
      : hslToHex(hue, sat, light);

  const accentHoverBg = isDark
    ? hslToHex(hue, Math.min(96, sat), Math.min(78, Math.max(58, light + 18)))
    : hslToHex(hue, sat, Math.max(18, light - 7));

  const accentFg = pickContrastForeground(accentBg);
  const washFactor =
    prefs.surfaceWash === 'off' ? 0 : prefs.surfaceWash === 'bold' ? 1 : 0.48;

  const canvasTint =
    washFactor === 0
      ? isDark
        ? '#09090b'
        : '#f4f4f5'
      : isDark
        ? hslToHex(hue, Math.round(sat * 0.28 * washFactor + 6), Math.round(6 + 4 * washFactor))
        : hslToHex(hue, Math.round(sat * 0.42 * washFactor + 8), Math.round(97 - 3.5 * washFactor));

  const surfaceTint =
    washFactor === 0
      ? isDark
        ? 'rgba(24, 24, 27, 0.95)'
        : 'rgba(255, 255, 255, 0.95)'
      : hexToRgba(
          isDark
            ? hslToHex(hue, Math.round(sat * 0.25 * washFactor + 6), Math.round(10 + 4 * washFactor))
            : hslToHex(hue, Math.round(sat * 0.36 * washFactor + 6), Math.round(99 - 3 * washFactor)),
          0.95,
        );

  const surfaceMutedTint =
    washFactor === 0
      ? isDark
        ? '#27272a'
        : '#fafafa'
      : isDark
        ? hslToHex(hue, Math.round(sat * 0.22 * washFactor + 8), Math.round(15 + 4 * washFactor))
        : hslToHex(hue, Math.round(sat * 0.32 * washFactor + 6), Math.round(97 - 3 * washFactor));

  const borderTint =
    washFactor === 0
      ? isDark
        ? '#27272a'
        : '#e4e4e7'
      : isDark
        ? hslToHex(hue, Math.round(sat * 0.28 * washFactor + 8), Math.round(20 + 6 * washFactor))
        : hslToHex(hue, Math.round(sat * 0.34 * washFactor + 8), Math.round(90 - 5 * washFactor));

  return {
    isDefaultMonochrome: false,
    accentBg,
    accentFg,
    accentHoverBg,
    accentSoftBg: hexToRgba(accentBg, isDark ? 0.18 : 0.12),
    accentSoftText: isDark
      ? hslToHex(hue, Math.min(92, sat), 78)
      : hslToHex(hue, Math.min(90, sat), Math.min(42, Math.max(24, light - 6))),
    accentBorder: hexToRgba(accentBg, isDark ? 0.42 : 0.34),
    surfaceBg: surfaceTint,
    surfaceMutedBg: surfaceMutedTint,
    canvasBg: canvasTint,
    borderColor: borderTint,
    glowColor: accentBg,
    cornerPx,
  };
}

export function resolveActivityColors(prefs: UserCustomization): ActivityColorsMap {
  if (prefs.activityPaletteId === 'custom') {
    return { ...prefs.customActivityColors };
  }
  const found =
    ACTIVITY_PALETTE_GROUPS.find((g) => g.id === prefs.activityPaletteId) ??
    ACTIVITY_PALETTE_GROUPS[0];
  return { ...found.colors };
}

export function resolveFallbackTrailColor(
  prefs: UserCustomization,
  tokens: ResolvedInterfaceTokens,
  scheme: 'light' | 'dark',
): string {
  if (prefs.mapAccents.fallbackTrailColor !== 'auto') {
    return prefs.mapAccents.fallbackTrailColor;
  }
  if (!tokens.isDefaultMonochrome) {
    return tokens.accentBg;
  }
  return scheme === 'dark' ? '#e4e4e7' : '#27272a';
}

export function getUserCustomizationStorageKey(userId: string): string {
  const cleanId = userId.trim();
  return `${USER_CUSTOMIZATION_STORAGE_PREFIX}${cleanId || 'guest'}`;
}

export function parseUserCustomization(raw: string | null | undefined): UserCustomization {
  if (!raw) return UserCustomizationSchema.parse({});
  try {
    const parsed = JSON.parse(raw);
    const result = UserCustomizationSchema.safeParse(parsed);
    return result.success ? result.data : UserCustomizationSchema.parse({});
  } catch {
    return UserCustomizationSchema.parse({});
  }
}

export const ACTIVITY_MODE_LABELS: Record<TrailActivityMode, string> = {
  walking: 'Walk',
  running: 'Run',
  cycling: 'Cycle',
  transit: 'Transit',
  driving: 'Drive',
  stationary: 'Stay',
};
