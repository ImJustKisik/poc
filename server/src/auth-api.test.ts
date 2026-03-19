import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

type TestApp = Awaited<ReturnType<typeof import('./index.js')['buildApp']>>;

interface RegisteredUser {
  userId: string;
  token: string;
  refreshToken: string;
  publicKey: string;
  secretKey: Uint8Array;
}

async function createTestContext() {
  vi.resetModules();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcm-server-test-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.DATABASE_PATH = path.join(tempDir, 'pcm.db');
  process.env.UPLOAD_DIR = path.join(tempDir, 'uploads');

  const [{ buildApp }, { initDb }] = await Promise.all([
    import('./index.js'),
    import('./db/index.js'),
  ]);

  await initDb();
  const app = await buildApp();
  return { app, tempDir };
}

function createRegisterPayload(displayName: string) {
  const identityKeyPair = nacl.sign.keyPair();
  const signedPreKey = nacl.box.keyPair();
  const signature = nacl.sign.detached(signedPreKey.publicKey, identityKeyPair.secretKey);
  const oneTimePreKeys = Array.from({ length: 3 }, (_, index) => {
    const keyPair = nacl.box.keyPair();
    return {
      keyId: index + 1,
      publicKey: naclUtil.encodeBase64(keyPair.publicKey),
    };
  });

  return {
    user: {
      publicKey: naclUtil.encodeBase64(identityKeyPair.publicKey),
      secretKey: identityKeyPair.secretKey,
      displayName,
    },
    payload: {
      publicKey: naclUtil.encodeBase64(identityKeyPair.publicKey),
      displayName,
      signedPreKey: {
        keyId: 1,
        publicKey: naclUtil.encodeBase64(signedPreKey.publicKey),
        signature: naclUtil.encodeBase64(signature),
      },
      oneTimePreKeys,
    },
  };
}

async function registerUser(app: TestApp, displayName: string): Promise<RegisteredUser> {
  const { user, payload } = createRegisterPayload(displayName);
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload,
  });

  const body = response.json();
  expect(response.statusCode).toBe(200);
  expect(body.success).toBe(true);

  return {
    userId: body.data.userId,
    token: body.data.token,
    refreshToken: body.data.refreshToken,
    publicKey: user.publicKey,
    secretKey: user.secretKey,
  };
}

describe('server auth and api flows', () => {
  let app: TestApp;
  let tempDir: string;

  beforeEach(async () => {
    ({ app, tempDir } = await createTestContext());
  });

  afterEach(async () => {
    await app?.close();
  });

  it('registers, challenges, verifies, and refreshes tokens', async () => {
    const user = await registerUser(app, 'Alice');

    const challengeRes = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { publicKey: user.publicKey },
    });

    expect(challengeRes.statusCode).toBe(200);
    const challengeBody = challengeRes.json();
    expect(challengeBody.success).toBe(true);

    const nonceBytes = naclUtil.decodeUTF8(challengeBody.data.nonce);
    const signature = nacl.sign.detached(nonceBytes, user.secretKey);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        publicKey: user.publicKey,
        signature: naclUtil.encodeBase64(signature),
        timestamp: Date.now(),
      },
    });

    expect(verifyRes.statusCode).toBe(200);
    const verifyBody = verifyRes.json();
    expect(verifyBody.success).toBe(true);
    expect(verifyBody.data.userId).toBe(user.userId);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: verifyBody.data.refreshToken },
    });

    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().data.token).toBeTruthy();
  });

  it('rejects invalid signature verification', async () => {
    const user = await registerUser(app, 'Alice');

    await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { publicKey: user.publicKey },
    });

    const invalidSignature = nacl.sign.detached(naclUtil.decodeUTF8('wrong'), user.secretKey);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        publicKey: user.publicKey,
        signature: naclUtil.encodeBase64(invalidSignature),
        timestamp: Date.now(),
      },
    });

    expect(verifyRes.statusCode).toBe(401);
    expect(verifyRes.json().error.code).toBe('INVALID_SIGNATURE');
  });

  it('creates a direct conversation and returns existing conversation on duplicate create', async () => {
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'direct', memberIds: [bob.userId] },
    });

    expect(createRes.statusCode).toBe(200);
    const createBody = createRes.json();
    expect(createBody.success).toBe(true);
    expect(createBody.data.members.sort()).toEqual([alice.userId, bob.userId].sort());

    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'direct', memberIds: [bob.userId] },
    });

    expect(duplicateRes.statusCode).toBe(200);
    expect(duplicateRes.json().data.existing).toBe(true);
  });

  it('rejects invalid direct conversation member count and non-admin member adds', async () => {
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');
    const charlie = await registerUser(app, 'Charlie');

    const invalidDirectRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'direct', memberIds: [bob.userId, charlie.userId] },
    });

    expect(invalidDirectRes.statusCode).toBe(400);
    expect(invalidDirectRes.json().error.code).toBe('INVALID_MEMBERS');

    const groupRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'group', name: 'Test', memberIds: [bob.userId] },
    });

    const addByNonAdminRes = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupRes.json().data.id}/members`,
      headers: { authorization: `Bearer ${bob.token}` },
      payload: { memberIds: [charlie.userId] },
    });

    expect(addByNonAdminRes.statusCode).toBe(403);
    expect(addByNonAdminRes.json().error.code).toBe('FORBIDDEN');
  });

  it('does not create a conversation when member ids are invalid', async () => {
    const alice = await registerUser(app, 'Alice');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'group', name: 'Broken', memberIds: ['missing-user'] },
    });

    expect(createRes.statusCode).toBe(400);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data).toEqual([]);
  });

  it('returns 410 when file metadata exists but blob is missing', async () => {
    const alice = await registerUser(app, 'Alice');
    const bob = await registerUser(app, 'Bob');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { authorization: `Bearer ${alice.token}` },
      payload: { type: 'direct', memberIds: [bob.userId] },
    });
    const conversationId = createRes.json().data.id as string;

    const { db, schema } = await import('./db/index.js');
    await db.insert(schema.files).values({
      id: 'missing-file',
      uploaderId: alice.userId,
      conversationId,
      fileName: 'bad\r\nname.txt',
      mimeType: 'application/octet-stream',
      size: 1,
      encryptedSize: 1,
      storagePath: path.join(tempDir, 'uploads', 'missing-file'),
      createdAt: Date.now(),
    });

    const fileRes = await app.inject({
      method: 'GET',
      url: '/api/files/missing-file',
      headers: { authorization: `Bearer ${alice.token}` },
    });

    expect(fileRes.statusCode).toBe(410);
    expect(fileRes.json().error.code).toBe('FILE_MISSING');
  });
});
