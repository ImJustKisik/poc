// ============================================================
// PCM Server — File Upload Routes
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { createReadStream } from 'fs';
import { serverConfig } from '../config.js';

const UPLOAD_DIR = serverConfig.uploadDir;

// Ensure upload dir exists
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function registerFileRoutes(app: FastifyInstance) {
  // POST /api/files/upload — Upload encrypted file
  app.post('/api/files/upload', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user as { userId: string };

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ success: false, error: { code: 'NO_FILE', message: 'No file provided' } });
    }

    const fileId = uuid();
    const conversationId = (data.fields.conversationId as { value: string })?.value || '';
    const originalName = (data.fields.fileName as { value: string })?.value || data.filename;
    const mimeType = (data.fields.mimeType as { value: string })?.value || data.mimetype;

    if (!conversationId) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_CONVERSATION', message: 'conversationId is required' } });
    }

    const membership = await db.select().from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.conversationId, conversationId));

    if (!membership.some(m => m.userId === userId)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    // Create date-based subdirectory
    const dateDir = new Date().toISOString().slice(0, 10);
    const dirPath = join(UPLOAD_DIR, dateDir);
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

    const filePath = join(dirPath, fileId);

    try {
      await pipeline(data.file, createWriteStream(filePath));
    } catch (error) {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      request.log.error({ err: error, fileId }, 'Failed to persist uploaded file');
      return reply.code(500).send({ success: false, error: { code: 'UPLOAD_FAILED', message: 'Failed to store file' } });
    }

    const { size } = await import('fs/promises').then(fs => fs.stat(filePath));

    // Save metadata
    await db.insert(schema.files).values({
      id: fileId,
      uploaderId: userId,
      conversationId,
      fileName: originalName,
      mimeType,
      size: Number(size),
      encryptedSize: Number(size),
      storagePath: filePath,
      createdAt: Date.now(),
    });

    return reply.send({
      success: true,
      data: {
        fileId,
        size: Number(size),
        downloadUrl: `/api/files/${fileId}`,
      },
    });
  });

  // GET /api/files/:fileId — Download encrypted file
  app.get('/api/files/:fileId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { fileId } = request.params as { fileId: string };
    const authHeader = request.headers.authorization;
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const token = bearerToken || queryToken;

    if (!token) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
    }

    let userId: string;
    try {
      const payload = app.jwt.verify(token) as { userId: string };
      userId = payload.userId;
    } catch {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
    }

    const files = await db.select().from(schema.files).where(eq(schema.files.id, fileId));
    if (files.length === 0) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    const file = files[0];
    if (!existsSync(file.storagePath)) {
      return reply.code(410).send({ success: false, error: { code: 'FILE_MISSING', message: 'Stored file is unavailable' } });
    }

    // Verify user has access (member of conversation)
    const membership = await db.select().from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.conversationId, file.conversationId));

    const isMember = membership.some(m => m.userId === userId);
    if (!isMember) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    const safeName = (file.fileName || 'download.bin').replace(/[\r\n"]/g, '_');
    const encodedFileName = encodeURIComponent(safeName);

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedFileName}`)
      .send(createReadStream(file.storagePath));
  });
}
