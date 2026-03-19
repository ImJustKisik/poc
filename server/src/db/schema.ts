// ============================================================
// PCM Server — Database Schema (Drizzle ORM + SQLite)
// ============================================================

import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// ---- Users ----
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatar: text('avatar'),
  customStatus: text('custom_status'),
  createdAt: integer('created_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
}, (table) => [
  uniqueIndex('users_public_key_idx').on(table.publicKey),
]);

// ---- Pre-Keys (for Signal Protocol X3DH) ----
export const signedPreKeys = sqliteTable('signed_pre_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  keyId: integer('key_id').notNull(),
  publicKey: text('public_key').notNull(),
  signature: text('signature').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('signed_pre_keys_user_idx').on(table.userId),
]);

export const oneTimePreKeys = sqliteTable('one_time_pre_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  keyId: integer('key_id').notNull(),
  publicKey: text('public_key').notNull(),
  used: integer('used', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('otp_keys_user_idx').on(table.userId),
]);

// ---- Conversations ----
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'direct' | 'group'
  name: text('name'),
  avatar: text('avatar'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: integer('created_at').notNull(),
});

export const conversationMembers = sqliteTable('conversation_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'), // 'admin' | 'member'
  joinedAt: integer('joined_at').notNull(),
}, (table) => [
  uniqueIndex('conv_member_unique').on(table.conversationId, table.userId),
  index('conv_members_conv_idx').on(table.conversationId),
  index('conv_members_user_idx').on(table.userId),
]);

// ---- Offline Message Queue (encrypted blobs) ----
export const messageQueue = sqliteTable('message_queue', {
  id: text('id').primaryKey(),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderId: text('sender_id').notNull().references(() => users.id),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  encryptedPayload: text('encrypted_payload').notNull(),
  messageType: text('message_type').notNull(),
  timestamp: integer('timestamp').notNull(),
  delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('msg_queue_recipient_idx').on(table.recipientId),
  index('msg_queue_timestamp_idx').on(table.timestamp),
]);

// ---- Encrypted File Metadata ----
export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  encryptedSize: integer('encrypted_size').notNull(),
  storagePath: text('storage_path').notNull(),
  createdAt: integer('created_at').notNull(),
});
