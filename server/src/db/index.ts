// ============================================================
// PCM Server — Database Connection (LibSQL/SQLite)
// ============================================================

import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { serverConfig } from '../config.js';

const DB_PATH = serverConfig.databasePath;

// Ensure directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const client = createClient({
  url: `file:${DB_PATH}`,
});

export const db = drizzle(client, { schema });

// Auto-create tables on first run
export async function initDb() {
  await client.executeMultiple(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar TEXT,
      custom_status TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signed_pre_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id INTEGER NOT NULL,
      public_key TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS one_time_pre_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id INTEGER NOT NULL,
      public_key TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      avatar TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      UNIQUE(conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_queue (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      encrypted_payload TEXT NOT NULL,
      message_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      uploader_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      encrypted_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS users_public_key_idx ON users(public_key);
    CREATE INDEX IF NOT EXISTS signed_pre_keys_user_idx ON signed_pre_keys(user_id);
    CREATE INDEX IF NOT EXISTS otp_keys_user_idx ON one_time_pre_keys(user_id);
    CREATE INDEX IF NOT EXISTS conv_members_conv_idx ON conversation_members(conversation_id);
    CREATE INDEX IF NOT EXISTS conv_members_user_idx ON conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS msg_queue_recipient_idx ON message_queue(recipient_id);
    CREATE INDEX IF NOT EXISTS msg_queue_timestamp_idx ON message_queue(timestamp);
  `);
}

export { schema };
