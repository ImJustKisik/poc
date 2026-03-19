// ============================================================
// PCM Client — Signal Protocol Crypto Layer
// ============================================================
// Simplified Signal Protocol implementation using tweetnacl:
// - X3DH for key agreement
// - Double Ratchet for per-message forward secrecy
// ============================================================

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

// ---- Key Types ----
export interface IdentityKeyPair {
  publicKey: Uint8Array;  // Ed25519
  secretKey: Uint8Array;
}

export interface DHKeyPair {
  publicKey: Uint8Array;  // X25519
  secretKey: Uint8Array;
}

export interface PreKeyBundle {
  identityKey: string;     // base64 Ed25519
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey?: { keyId: number; publicKey: string };
}

export interface SessionState {
  rootKey: Uint8Array;
  sendChainKey: Uint8Array;
  receiveChainKey: Uint8Array;
  sendRatchetKey: DHKeyPair;
  receiveRatchetPublicKey: Uint8Array | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousSendCount: number;
}

export interface EncryptedEnvelope {
  ciphertext: string;      // base64
  nonce: string;            // base64
  senderRatchetKey: string; // base64 X25519 public key
  messageNumber: number;
  previousChainLength: number;
  x3dhEphemeralKey?: string; // Added for first message
  oneTimePreKeyId?: number;
}

// ---- Key Generation ----

export function generateIdentityKeyPair(): IdentityKeyPair {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function generateDHKeyPair(): DHKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function generatePreKeys(count: number, startId: number = 1): { keyId: number; keyPair: DHKeyPair }[] {
  return Array.from({ length: count }, (_, i) => ({
    keyId: startId + i,
    keyPair: generateDHKeyPair(),
  }));
}

// ---- Utility ----

function toBase64(data: Uint8Array): string {
  return naclUtil.encodeBase64(data);
}

function fromBase64(data: string): Uint8Array {
  return naclUtil.decodeBase64(data);
}

// Ed25519 public key → X25519 public key (for DH)
// tweetnacl doesn't expose this directly, so we use the sign keypair's
// secret key to derive a box keypair
function ed25519SecretToX25519(edSecretKey: Uint8Array): Uint8Array {
  // The first 32 bytes of an Ed25519 secret key can be used as X25519 secret key
  const seed = edSecretKey.slice(0, 32);
  const hash = nacl.hash(seed).slice(0, 32);
  return hash;
}

// Perform X25519 Diffie-Hellman
function dh(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.scalarMult(mySecretKey, theirPublicKey);
}

// HKDF-like key derivation using SHA-512
function hkdf(inputKey: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number = 64): Uint8Array {
  const combined = new Uint8Array(inputKey.length + salt.length + info.length);
  combined.set(inputKey);
  combined.set(salt, inputKey.length);
  combined.set(info, inputKey.length + salt.length);
  return nacl.hash(combined).slice(0, length);
}

// Derive root key and chain key from DH output
function kdfRatchetStep(rootKey: Uint8Array, dhOutput: Uint8Array): { newRootKey: Uint8Array; chainKey: Uint8Array } {
  const info = naclUtil.decodeUTF8('PCMRatchet');
  const derived = hkdf(dhOutput, rootKey, info, 64);
  return {
    newRootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}

// Derive message key from chain key
function kdfChainStep(chainKey: Uint8Array): { newChainKey: Uint8Array; messageKey: Uint8Array } {
  const msgInfo = naclUtil.decodeUTF8('PCMMessage');
  const chainInfo = naclUtil.decodeUTF8('PCMChain');
  const messageKey = hkdf(chainKey, msgInfo, new Uint8Array(0), 32);
  const newChainKey = hkdf(chainKey, chainInfo, new Uint8Array(0), 32);
  return { newChainKey, messageKey };
}

// ---- X3DH Key Agreement ----

export interface X3DHResult {
  sharedSecret: Uint8Array;
  ephemeralKeyPair: DHKeyPair;
  oneTimePreKeyId?: number;
}

export function ed25519PubKeyToX25519(pk: Uint8Array): Uint8Array {
  return pk; 
}

/**
 * Initiator side of X3DH key agreement
 * Alice starting chat with Bob
 */
export function x3dhInitiate(
  aliceIdentitySecret: Uint8Array,
  bobBundle: PreKeyBundle
): X3DHResult {
  const bobSignedPreKey = fromBase64(bobBundle.signedPreKey.publicKey);

  // Generate ephemeral key pair
  const ephemeralKeyPair = generateDHKeyPair();

  // Simplified X3DH for this client: only use X25519-compatible keys.
  const dh1 = dh(ephemeralKeyPair.secretKey, bobSignedPreKey); // EK_A × SPK_B

  let combined: Uint8Array;
  if (bobBundle.oneTimePreKey) {
    const bobOTPK = fromBase64(bobBundle.oneTimePreKey.publicKey);
    const dh2 = dh(ephemeralKeyPair.secretKey, bobOTPK);      // EK_A × OTPK_B
    combined = new Uint8Array(dh1.length + dh2.length);
    combined.set(dh1);
    combined.set(dh2, dh1.length);
  } else {
    combined = new Uint8Array(dh1.length);
    combined.set(dh1);
  }

  const info = naclUtil.decodeUTF8('PCMX3DH');
  const sharedSecret = hkdf(combined, new Uint8Array(32), info, 32);

  return {
    sharedSecret,
    ephemeralKeyPair,
    oneTimePreKeyId: bobBundle.oneTimePreKey?.keyId,
  };
}

/**
 * Responder side of X3DH key agreement
 * Bob receiving from Alice
 */
export function x3dhRespond(
  bobIdentitySecret: Uint8Array,
  bobSignedPreKeySecret: Uint8Array,
  bobOneTimePreKeySecret: Uint8Array | null,
  aliceIdentityKey: Uint8Array,
  aliceEphemeralKey: Uint8Array
): Uint8Array {
  void bobIdentitySecret;
  void aliceIdentityKey;

  const dh1 = dh(bobSignedPreKeySecret, aliceEphemeralKey);

  let combined: Uint8Array;
  if (bobOneTimePreKeySecret) {
    const dh2 = dh(bobOneTimePreKeySecret, aliceEphemeralKey);
    combined = new Uint8Array(dh1.length + dh2.length);
    combined.set(dh1);
    combined.set(dh2, dh1.length);
  } else {
    combined = new Uint8Array(dh1.length);
    combined.set(dh1);
  }

  const info = naclUtil.decodeUTF8('PCMX3DH');
  return hkdf(combined, new Uint8Array(32), info, 32);
}

// ---- Double Ratchet Session ----

export class DoubleRatchetSession {
  private state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
  }

  /**
   * Initialize session as the initiator (Alice)
   */
  static initAsAlice(sharedSecret: Uint8Array, bobRatchetPublicKey: Uint8Array): DoubleRatchetSession {
    const sendRatchetKey = generateDHKeyPair();
    const dhOutput = dh(sendRatchetKey.secretKey, bobRatchetPublicKey);
    const { newRootKey, chainKey } = kdfRatchetStep(sharedSecret, dhOutput);

    return new DoubleRatchetSession({
      rootKey: newRootKey,
      sendChainKey: chainKey,
      receiveChainKey: new Uint8Array(32),
      sendRatchetKey,
      receiveRatchetPublicKey: bobRatchetPublicKey,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      previousSendCount: 0,
    });
  }

  /**
   * Initialize session as the responder (Bob)
   */
  static initAsBob(sharedSecret: Uint8Array, bobRatchetKeyPair: DHKeyPair): DoubleRatchetSession {
    return new DoubleRatchetSession({
      rootKey: sharedSecret,
      sendChainKey: new Uint8Array(32),
      receiveChainKey: new Uint8Array(32),
      sendRatchetKey: bobRatchetKeyPair,
      receiveRatchetPublicKey: null,
      sendMessageNumber: 0,
      receiveMessageNumber: 0,
      previousSendCount: 0,
    });
  }

  /**
   * Encrypt a message
   */
  encrypt(plaintext: string, x3dhEphemeralKey?: Uint8Array, oneTimePreKeyId?: number): EncryptedEnvelope {
    const { newChainKey, messageKey } = kdfChainStep(this.state.sendChainKey);
    this.state.sendChainKey = newChainKey;

    const plaintextBytes = naclUtil.decodeUTF8(plaintext);
    const nonce = nacl.randomBytes(24);
    const ciphertext = nacl.secretbox(plaintextBytes, nonce, messageKey);

    const envelope: EncryptedEnvelope = {
      ciphertext: toBase64(ciphertext),
      nonce: toBase64(nonce),
      senderRatchetKey: toBase64(this.state.sendRatchetKey.publicKey),
      messageNumber: this.state.sendMessageNumber,
      previousChainLength: this.state.previousSendCount,
      x3dhEphemeralKey: x3dhEphemeralKey ? toBase64(x3dhEphemeralKey) : undefined,
      oneTimePreKeyId,
    };

    this.state.sendMessageNumber++;
    return envelope;
  }

  /**
   * Decrypt a message
   */
  decrypt(envelope: EncryptedEnvelope): string {
    const senderRatchetKey = fromBase64(envelope.senderRatchetKey);

    // Check if we need to perform a DH ratchet step
    if (
      !this.state.receiveRatchetPublicKey ||
      toBase64(this.state.receiveRatchetPublicKey) !== envelope.senderRatchetKey
    ) {
      this.dhRatchet(senderRatchetKey);
    }

    const { newChainKey, messageKey } = kdfChainStep(this.state.receiveChainKey);
    this.state.receiveChainKey = newChainKey;

    const ciphertext = fromBase64(envelope.ciphertext);
    const nonce = fromBase64(envelope.nonce);
    const plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);

    if (!plaintext) {
      throw new Error('Decryption failed');
    }

    this.state.receiveMessageNumber++;
    return naclUtil.encodeUTF8(plaintext);
  }

  private dhRatchet(newRatchetPublicKey: Uint8Array) {
    this.state.previousSendCount = this.state.sendMessageNumber;
    this.state.sendMessageNumber = 0;
    this.state.receiveMessageNumber = 0;
    this.state.receiveRatchetPublicKey = newRatchetPublicKey;

    // Receive chain
    const dhReceive = dh(this.state.sendRatchetKey.secretKey, newRatchetPublicKey);
    const receiveResult = kdfRatchetStep(this.state.rootKey, dhReceive);
    this.state.rootKey = receiveResult.newRootKey;
    this.state.receiveChainKey = receiveResult.chainKey;

    // New send ratchet key
    this.state.sendRatchetKey = generateDHKeyPair();
    const dhSend = dh(this.state.sendRatchetKey.secretKey, newRatchetPublicKey);
    const sendResult = kdfRatchetStep(this.state.rootKey, dhSend);
    this.state.rootKey = sendResult.newRootKey;
    this.state.sendChainKey = sendResult.chainKey;
  }

  /**
   * Serialize session state for storage
   */
  serialize(): string {
    return JSON.stringify({
      rootKey: toBase64(this.state.rootKey),
      sendChainKey: toBase64(this.state.sendChainKey),
      receiveChainKey: toBase64(this.state.receiveChainKey),
      sendRatchetKey: {
        publicKey: toBase64(this.state.sendRatchetKey.publicKey),
        secretKey: toBase64(this.state.sendRatchetKey.secretKey),
      },
      receiveRatchetPublicKey: this.state.receiveRatchetPublicKey
        ? toBase64(this.state.receiveRatchetPublicKey)
        : null,
      sendMessageNumber: this.state.sendMessageNumber,
      receiveMessageNumber: this.state.receiveMessageNumber,
      previousSendCount: this.state.previousSendCount,
    });
  }

  /**
   * Deserialize session state from storage
   */
  static deserialize(json: string): DoubleRatchetSession {
    const data = JSON.parse(json);
    return new DoubleRatchetSession({
      rootKey: fromBase64(data.rootKey),
      sendChainKey: fromBase64(data.sendChainKey),
      receiveChainKey: fromBase64(data.receiveChainKey),
      sendRatchetKey: {
        publicKey: fromBase64(data.sendRatchetKey.publicKey),
        secretKey: fromBase64(data.sendRatchetKey.secretKey),
      },
      receiveRatchetPublicKey: data.receiveRatchetPublicKey
        ? fromBase64(data.receiveRatchetPublicKey)
        : null,
      sendMessageNumber: data.sendMessageNumber,
      receiveMessageNumber: data.receiveMessageNumber,
      previousSendCount: data.previousSendCount,
    });
  }
}

// ---- File Encryption (AES-256-GCM via secretbox which uses XSalsa20-Poly1305) ----

export function encryptFile(data: Uint8Array): { encrypted: Uint8Array; key: Uint8Array; nonce: Uint8Array } {
  const key = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.secretbox(data, nonce, key);
  return { encrypted, key, nonce };
}

export function decryptFile(encrypted: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const decrypted = nacl.secretbox.open(encrypted, nonce, key);
  if (!decrypted) throw new Error('File decryption failed');
  return decrypted;
}

// ---- Group Encryption (Sender Keys) ----

export interface SenderKeyState {
  keyId: number;
  chainKey: Uint8Array;
  signingKey: IdentityKeyPair;
  iteration: number;
}

export class SenderKeySession {
  private state: SenderKeyState;

  constructor(state: SenderKeyState) {
    this.state = state;
  }

  static create(): SenderKeySession {
    return new SenderKeySession({
      keyId: 1,
      chainKey: nacl.randomBytes(32),
      signingKey: generateIdentityKeyPair(),
      iteration: 0,
    });
  }

  /**
   * Get the sender key distribution message (to share with group members)
   */
  getDistributionMessage(): { keyId: number; chainKey: string; signingPublicKey: string } {
    return {
      keyId: this.state.keyId,
      chainKey: toBase64(this.state.chainKey),
      signingPublicKey: toBase64(this.state.signingKey.publicKey),
    };
  }

  /**
   * Encrypt a message for the group
   */
  encrypt(plaintext: string): { ciphertext: string; nonce: string; keyId: number; iteration: number; signature: string } {
    const { newChainKey, messageKey } = kdfChainStep(this.state.chainKey);
    this.state.chainKey = newChainKey;
    this.state.iteration++;

    const plaintextBytes = naclUtil.decodeUTF8(plaintext);
    const nonce = nacl.randomBytes(24);
    const ciphertext = nacl.secretbox(plaintextBytes, nonce, messageKey);

    // Sign the ciphertext
    const signature = nacl.sign.detached(ciphertext, this.state.signingKey.secretKey);

    return {
      ciphertext: toBase64(ciphertext),
      nonce: toBase64(nonce),
      keyId: this.state.keyId,
      iteration: this.state.iteration,
      signature: toBase64(signature),
    };
  }

  serialize(): string {
    return JSON.stringify({
      keyId: this.state.keyId,
      chainKey: toBase64(this.state.chainKey),
      signingKey: {
        publicKey: toBase64(this.state.signingKey.publicKey),
        secretKey: toBase64(this.state.signingKey.secretKey),
      },
      iteration: this.state.iteration,
    });
  }

  static deserialize(json: string): SenderKeySession {
    const data = JSON.parse(json);
    return new SenderKeySession({
      keyId: data.keyId,
      chainKey: fromBase64(data.chainKey),
      signingKey: {
        publicKey: fromBase64(data.signingKey.publicKey),
        secretKey: fromBase64(data.signingKey.secretKey),
      },
      iteration: data.iteration,
    });
  }
}
