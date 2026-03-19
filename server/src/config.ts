const env = process.env.NODE_ENV || 'development';

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) {
    if (env === 'production' && secret === 'change-this-to-a-random-secret') {
      throw new Error('JWT_SECRET must not use the example value in production');
    }
    return secret;
  }

  if (env === 'development' || env === 'test') {
    return 'dev-secret-change-me';
  }

  throw new Error('JWT_SECRET must be set outside development/test environments');
}

function getCorsOrigins(): true | string[] {
  const configured = process.env.CORS_ORIGIN?.trim();
  if (configured) {
    if (configured === '*') {
      if (env === 'production') {
        throw new Error('CORS_ORIGIN cannot be "*" in production');
      }
      return true;
    }

    return configured.split(',').map((item) => item.trim()).filter(Boolean);
  }

  if (env === 'development' || env === 'test') {
    return true;
  }

  throw new Error('CORS_ORIGIN must be set in production');
}

export const serverConfig = {
  env,
  port: parseNumber(process.env.PORT, 3001),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: getJwtSecret(),
  databasePath: process.env.DATABASE_PATH || './data/pcm.db',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  corsOrigin: getCorsOrigins(),
  maxFileSize: parseNumber(process.env.MAX_FILE_SIZE, 104857600),
  logLevel: process.env.LOG_LEVEL || 'info',
  sfuListenIp: process.env.SFU_LISTEN_IP || '0.0.0.0',
  sfuAnnouncedIp: process.env.SFU_ANNOUNCED_IP || undefined,
  sfuMinPort: parseNumber(process.env.SFU_MIN_PORT, 20000),
  sfuMaxPort: parseNumber(process.env.SFU_MAX_PORT, 30000),
};

export function requireProductionEnv(): void {
  if (serverConfig.env !== 'production') {
    return;
  }

  requireEnv('JWT_SECRET');
  requireEnv('CORS_ORIGIN');
}
