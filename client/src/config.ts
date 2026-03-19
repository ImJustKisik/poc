const DEV_DEFAULT_SERVER_URL = 'http://localhost:3001';

export const DEFAULT_SERVER_URL =
  import.meta.env.DEV ? DEV_DEFAULT_SERVER_URL : '';

export const NOTIFICATION_SOUND_DATA_URI =
  'data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTAAAAAAAP//AAD//wAA//8AAP//AAD//wAA';

export function resolveServerUrl(value?: string | null): string {
  const normalized = value?.trim() ?? '';
  if (normalized) {
    return normalized.replace(/\/+$/, '');
  }

  return DEFAULT_SERVER_URL;
}
