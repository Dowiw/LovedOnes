import { isSafeAvatarUrl } from '@loved-ones/shared';

export type PickAvatarResult =
  | { status: 'ok'; dataUri: string }
  | { status: 'cancelled' }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string };

/**
 * Opens the device photo library with a forced 1:1 square cropper, resizes to 192x192,
 * and returns a bounded base64 JPEG data URI matching web AccountSettingsModal.
 */
export async function pickAndCropSquareAvatar(): Promise<PickAvatarResult> {
  try {
    const ImagePicker = await import('expo-image-picker');
    const ImageManipulator = await import('expo-image-manipulator');

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return {
        status: 'denied',
        message: 'Photo library permission is needed to attach a profile photo.',
      };
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
      base64: false,
    });

    if (picked.canceled || !picked.assets || picked.assets.length === 0) {
      return { status: 'cancelled' };
    }

    const asset = picked.assets[0];
    const width = asset.width || 192;
    const height = asset.height || 192;
    const actions: Array<
      | { crop: { originX: number; originY: number; width: number; height: number } }
      | { resize: { width: number; height: number } }
    > = [];

    if (Math.abs(width - height) > 2) {
      const side = Math.min(width, height);
      actions.push({
        crop: {
          originX: Math.max(0, Math.floor((width - side) / 2)),
          originY: Math.max(0, Math.floor((height - side) / 2)),
          width: side,
          height: side,
        },
      });
    }
    actions.push({ resize: { width: 192, height: 192 } });

    const manipulated = await ImageManipulator.manipulateAsync(asset.uri, actions, {
      compress: 0.84,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });

    if (!manipulated.base64) {
      return { status: 'error', message: 'Could not encode cropped photo.' };
    }

    const dataUri = `data:image/jpeg;base64,${manipulated.base64}`;
    if (!isSafeAvatarUrl(dataUri)) {
      return { status: 'error', message: 'Cropped image exceeds the 256 KB avatar limit.' };
    }
    return { status: 'ok', dataUri };
  } catch {
    return {
      status: 'error',
      message: 'Photo picker is unavailable on this build. You can still paste an image link.',
    };
  }
}
