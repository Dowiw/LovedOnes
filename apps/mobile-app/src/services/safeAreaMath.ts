export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Computes conservative safe-area insets across Android (3-button & gesture nav bars)
 * and iOS without requiring extra native C++ binary dependencies.
 */
export function computeSafeAreaInsets(
  platform: string,
  statusBarHeight: number | null,
  screenHeight: number,
  windowHeight: number,
): EdgeInsets {
  if (platform === 'android') {
    const status = Math.max(statusBarHeight ?? 0, 28);
    const navDelta = Math.max(0, screenHeight - windowHeight);
    return {
      top: status,
      right: 0,
      bottom: Math.max(navDelta, 48),
      left: 0,
    };
  }

  if (platform === 'ios') {
    return {
      top: 48,
      right: 0,
      bottom: 34,
      left: 0,
    };
  }

  return {
    top: 28,
    right: 0,
    bottom: 24,
    left: 0,
  };
}
