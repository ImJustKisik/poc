import { describe, expect, it } from 'vitest';
import naclUtil from 'tweetnacl-util';
import {
  DoubleRatchetSession,
  decryptFile,
  encryptFile,
  generateDHKeyPair,
  x3dhInitiate,
  x3dhRespond,
} from './crypto';

describe('crypto service', () => {
  it('encrypts and decrypts files', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { encrypted, key, nonce } = encryptFile(input);
    expect(decryptFile(encrypted, key, nonce)).toEqual(input);
  });

  it('bootstraps a ratchet session through X3DH and exchanges messages', () => {
    const aliceIdentity = generateDHKeyPair();
    const bobIdentity = generateDHKeyPair();
    const bobSignedPreKey = generateDHKeyPair();
    const bobOneTimePreKey = generateDHKeyPair();

    const initiated = x3dhInitiate(aliceIdentity.secretKey, {
      identityKey: naclUtil.encodeBase64(bobIdentity.publicKey),
      signedPreKey: {
        keyId: 1,
        publicKey: naclUtil.encodeBase64(bobSignedPreKey.publicKey),
        signature: 'sig',
      },
      oneTimePreKey: {
        keyId: 2,
        publicKey: naclUtil.encodeBase64(bobOneTimePreKey.publicKey),
      },
    });

    const responded = x3dhRespond(
      bobIdentity.secretKey,
      bobSignedPreKey.secretKey,
      bobOneTimePreKey.secretKey,
      aliceIdentity.publicKey,
      initiated.ephemeralKeyPair.publicKey,
    );

    const aliceSession = DoubleRatchetSession.initAsAlice(initiated.sharedSecret, bobSignedPreKey.publicKey);
    const bobSession = DoubleRatchetSession.initAsBob(responded, {
      publicKey: bobSignedPreKey.publicKey,
      secretKey: bobSignedPreKey.secretKey,
    });

    const envelope = aliceSession.encrypt('hello');
    expect(bobSession.decrypt(envelope)).toBe('hello');
  });
});
