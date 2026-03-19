// ============================================================
// PCM Protocol Constants
// ============================================================

export const PROTOCOL_VERSION = 1;

export const MAX_GROUP_SIZE = 64;
export const MAX_MESSAGE_SIZE = 64 * 1024;   // 64 KB text
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
export const MAX_MEDIA_DIMENSION = 4096;

export const CHUNK_SIZE = 64 * 1024;          // 64 KB chunks for file transfer

export const WS_HEARTBEAT_INTERVAL = 30_000;  // 30 seconds
export const WS_RECONNECT_BASE_DELAY = 1_000; // 1 second
export const WS_RECONNECT_MAX_DELAY = 30_000; // 30 seconds

export const TOKEN_EXPIRY = 15 * 60;          // 15 min access token
export const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60; // 30 days

export const ONE_TIME_PREKEY_COUNT = 100;      // Initial number of OTP keys
export const ONE_TIME_PREKEY_THRESHOLD = 20;   // Refill when below this

export const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
];

export const SUPPORTED_VIDEO_TYPES = [
  'video/mp4', 'video/webm', 'video/quicktime',
];

export const SUPPORTED_AUDIO_TYPES = [
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
];
