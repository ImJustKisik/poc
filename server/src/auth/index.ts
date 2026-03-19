// ============================================================
// PCM Server — Key-Based Authentication
// ============================================================

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { v4 as uuid } from 'uuid';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { AuthChallenge, AuthResponse, AuthResult, UserIdentity } from '@pcm/shared';

// Store pending challenges in memory (short-lived)
const pendingChallenges = new Map<string, { nonce: string; timestamp: number }>();

// Cleanup expired challenges every 5 minutes
const challengeCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, challenge] of pendingChallenges) {
    if (now - challenge.timestamp > 5 * 60 * 1000) {
      pendingChallenges.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function stopAuthChallengeCleanup() {
  clearInterval(challengeCleanupTimer);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function registerAuthRoutes(app: FastifyInstance) {
  // POST /auth/register — Register a new user with their public key
  app.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      publicKey: string;
      displayName: string;
      signedPreKey: { keyId: number; publicKey: string; signature: string };
      oneTimePreKeys: { keyId: number; publicKey: string }[];
    };

    const { publicKey, displayName, signedPreKey, oneTimePreKeys } = body;
    if (
      !isNonEmptyString(publicKey) ||
      !isNonEmptyString(displayName) ||
      !signedPreKey ||
      !Number.isInteger(signedPreKey.keyId) ||
      !isNonEmptyString(signedPreKey.publicKey) ||
      !isNonEmptyString(signedPreKey.signature) ||
      !Array.isArray(oneTimePreKeys)
    ) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Invalid registration payload' } });
    }

    // Check if user already registered
    const existing = await db.select().from(schema.users).where(eq(schema.users.publicKey, publicKey));
    if (existing.length > 0) {
      return reply.code(409).send({ success: false, error: { code: 'USER_EXISTS', message: 'User with this public key already exists' } });
    }

    const userId = uuid();
    const now = Date.now();

    await db.transaction(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        publicKey,
        displayName,
        createdAt: now,
        lastSeen: now,
      });

      await tx.insert(schema.signedPreKeys).values({
        userId,
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        createdAt: now,
      });

      if (oneTimePreKeys.length > 0) {
        await tx.insert(schema.oneTimePreKeys).values(
          oneTimePreKeys.map(k => ({
            userId,
            keyId: k.keyId,
            publicKey: k.publicKey,
          }))
        );
      }
    });

    // Generate tokens
    const token = app.jwt.sign({ userId, publicKey }, { expiresIn: '15m' });
    const refreshToken = app.jwt.sign({ userId, publicKey, type: 'refresh' }, { expiresIn: '30d' });

    return reply.send({
      success: true,
      data: { userId, token, refreshToken },
    });
  });

  // POST /auth/challenge — Request a login challenge
  app.post('/auth/challenge', async (request: FastifyRequest, reply: FastifyReply) => {
    const { publicKey } = request.body as { publicKey: string };
    if (!isNonEmptyString(publicKey)) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'publicKey is required' } });
    }

    // Verify user exists
    const users = await db.select().from(schema.users).where(eq(schema.users.publicKey, publicKey));
    if (users.length === 0) {
      return reply.code(404).send({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }

    // Generate challenge nonce
    const nonce = naclUtil.encodeBase64(nacl.randomBytes(32));
    const challenge: AuthChallenge = { nonce, timestamp: Date.now() };

    pendingChallenges.set(publicKey, challenge);

    return reply.send({ success: true, data: challenge });
  });

  // POST /auth/verify — Verify signed challenge
  app.post('/auth/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { publicKey, signature } = request.body as AuthResponse;
    if (!isNonEmptyString(publicKey) || !isNonEmptyString(signature)) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'publicKey and signature are required' } });
    }

    const challenge = pendingChallenges.get(publicKey);
    if (!challenge) {
      return reply.code(400).send({ success: false, error: { code: 'NO_CHALLENGE', message: 'No pending challenge. Request a challenge first.' } });
    }

    // Check challenge expiry (5 minutes)
    if (Date.now() - challenge.timestamp > 5 * 60 * 1000) {
      pendingChallenges.delete(publicKey);
      return reply.code(400).send({ success: false, error: { code: 'CHALLENGE_EXPIRED', message: 'Challenge expired' } });
    }

    // Verify Ed25519 signature
    const messageBytes = naclUtil.decodeUTF8(challenge.nonce);
    const signatureBytes = naclUtil.decodeBase64(signature);
    const publicKeyBytes = naclUtil.decodeBase64(publicKey);

    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

    if (!valid) {
      pendingChallenges.delete(publicKey);
      return reply.code(401).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
    }

    pendingChallenges.delete(publicKey);

    // Find user
    const users = await db.select().from(schema.users).where(eq(schema.users.publicKey, publicKey));
    const user = users[0];

    // Update last seen
    await db.update(schema.users).set({ lastSeen: Date.now() }).where(eq(schema.users.id, user.id));

    // Generate tokens
    const token = app.jwt.sign({ userId: user.id, publicKey }, { expiresIn: '15m' });
    const refreshToken = app.jwt.sign({ userId: user.id, publicKey, type: 'refresh' }, { expiresIn: '30d' });

    const result: AuthResult = {
      success: true,
      token,
      refreshToken,
      userId: user.id,
    };

    return reply.send({ success: true, data: result });
  });

  // POST /auth/refresh — Refresh access token
  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const { refreshToken } = request.body as { refreshToken: string };

    try {
      const payload = app.jwt.verify(refreshToken) as { userId: string; publicKey: string; type: string };
      if (payload.type !== 'refresh') {
        return reply.code(400).send({ success: false, error: { code: 'INVALID_TOKEN', message: 'Not a refresh token' } });
      }

      const token = app.jwt.sign({ userId: payload.userId, publicKey: payload.publicKey }, { expiresIn: '15m' });

      return reply.send({ success: true, data: { token } });
    } catch {
      return reply.code(401).send({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid refresh token' } });
    }
  });
}
