let handlerConfigured = false;

async function ensureNotificationReady() {
  const Notifications = await import('expo-notifications');
  if (!handlerConfigured) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    handlerConfigured = true;
  }

  const current = await Notifications.getPermissionsAsync();
  if (current.status !== 'granted') {
    const next = await Notifications.requestPermissionsAsync();
    if (next.status !== 'granted') {
      return null;
    }
  }
  return Notifications;
}

/**
 * Triggers a local OS notification on iOS and Android without failing in Vitest or
 * builds where notifications permission was declined.
 */
export async function sendLocalNotification(title: string, body: string): Promise<boolean> {
  try {
    const Notifications = await ensureNotificationReady();
    if (!Notifications) return false;
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}
