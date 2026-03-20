// ============================================================
// PCM Client — Main App Component
// ============================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore, useConversationsStore, useMessagesStore, usePresenceStore, useCallStore, useUIStore } from './stores';
import { MessageType, MessageStatus, ConversationType, UserStatus, CallType, CallStatus, WSEventType } from '@pcm/shared';
import type { DecryptedMessage, Conversation } from '@pcm/shared';
import { v4 as uuid } from 'uuid';
import { format, isToday, isYesterday } from 'date-fns';
import notifications from './services/notifications';
import { getCallService } from './services/calls';
import { getWSService, createWSService } from './services/websocket';
import { DoubleRatchetSession, x3dhInitiate, x3dhRespond } from './services/crypto';
import { configureApi, getConversations, getUserByPublicKey, createConversation, refreshAuthToken, updateApiToken, updateProfile } from './services/api';
import { resolveServerUrl } from './config';
import * as naclUtil from 'tweetnacl-util'; 
import { useSessionStore } from './stores';
import { logDebug, logError } from './services/logger';

const callService = getCallService();


// ---- Constants ----
const EMOJIS = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','🤨','🧐','🤠','🤡','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🤲','👐','🙌','👏','🤝','👍','👎','👊','✊','🤛','🤜','🤞','✌️','🤟','🤘','👌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤙','💪','🖕','✍️','🙏','💍','💄','💋','👄','👅','👂','👃','👣','👁','👀'];

const EMPTY_ARRAY: any[] = [];

async function persistLocalKeys(updates: Record<string, unknown>) {
  if (!window.pcm?.keys) return;
  const existingRaw = await window.pcm.keys.load();
  const existingKeys = existingRaw ? JSON.parse(existingRaw) : {};
  await window.pcm.keys.store(JSON.stringify({
    ...existingKeys,
    ...updates,
  }));
}

// ---- Utility Helpers ----
function getInitials(name: string): string {
  if (!name) return '??';
  const initials = name.trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();
  return initials.slice(0, 2) || '??';
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  return format(date, 'HH:mm');
}

function formatDate(ts: number): string {
  const date = new Date(ts);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMMM d, yyyy');
}

function groupMessagesByDate(messages: DecryptedMessage[]): { date: string; messages: DecryptedMessage[] }[] {
  const groups: { date: string; messages: DecryptedMessage[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const dateStr = formatDate(msg.timestamp);
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      groups.push({ date: dateStr, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

// ---- SVG Icons ----
const Icons = {
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  menu: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  send: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>,
  attach: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
  emoji: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>,
  mic: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>,
  phone: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>,
  video: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>,
  moreVert: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  close: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  minimize: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  maximize: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>,
  back: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  settings: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  lock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  checkDouble: <svg width="20" height="16" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/><polyline points="26 6 15 17 12 14"/></svg>,
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  pause: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>,
  plus: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  phoneEnd: <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.69 8.68 7.62 7 12 7s8.31 1.68 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>,
  key: <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  shield: <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.3"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  user: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  group: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  copy: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
};

// ============================================================
// Title Bar Component
// ============================================================
function TitleBar() {
  return (
    <div className="titlebar">
      <span className="titlebar__title">🔐 PCM</span>
      <div className="titlebar__controls">
        <button className="titlebar__btn" onClick={() => window.pcm?.window.minimize()} title="Minimize">
          {Icons.minimize}
        </button>
        <button className="titlebar__btn" onClick={() => window.pcm?.window.maximize()} title="Maximize">
          {Icons.maximize}
        </button>
        <button className="titlebar__btn titlebar__btn--close" onClick={() => window.pcm?.window.close()} title="Close">
          {Icons.close}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Auth Screen
// ============================================================
function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [displayName, setDisplayName] = useState('');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [serverUrl, setServerUrl] = useState(() => resolveServerUrl(useAuthStore.getState().serverUrl));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generatedKeys, setGeneratedKeys] = useState<{ publicKey: string; privateKey: string } | null>(null);
  const login = useAuthStore(s => s.login);

  const handleRegister = async () => {
    if (!displayName.trim()) {
      setError('Enter your display name');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const nacl = await import('tweetnacl');
      const naclUtil = await import('tweetnacl-util');

      // Generate Ed25519 identity key pair
      const identityKeyPair = nacl.default.sign.keyPair();
      const publicKeyB64 = naclUtil.default.encodeBase64(identityKeyPair.publicKey);
      const privateKeyB64 = naclUtil.default.encodeBase64(identityKeyPair.secretKey);

      // Generate X25519 signed pre-key
      const signedPreKeyPair = nacl.default.box.keyPair();
      const signedPreKeySignature = nacl.default.sign.detached(
        signedPreKeyPair.publicKey,
        identityKeyPair.secretKey
      );

      // Generate one-time pre-keys
      const oneTimePreKeys = Array.from({ length: 100 }, (_, i) => {
        const kp = nacl.default.box.keyPair();
        return {
          keyId: i + 1,
          publicKey: naclUtil.default.encodeBase64(kp.publicKey),
          privateKey: naclUtil.default.encodeBase64(kp.secretKey),
        };
      });

      const res = await fetch(`${serverUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKeyB64,
          displayName: displayName.trim(),
          signedPreKey: {
            keyId: 1,
            publicKey: naclUtil.default.encodeBase64(signedPreKeyPair.publicKey),
            signature: naclUtil.default.encodeBase64(signedPreKeySignature),
          },
          oneTimePreKeys: oneTimePreKeys.map(({ keyId, publicKey }) => ({ keyId, publicKey })),
        }),
      });

      const result = await res.json() as { success: boolean; data?: { userId: string; token: string; refreshToken: string }; error?: { message?: string } };
      if (!result.success || !result.data) {
        setError(result.error?.message || 'Registration failed');
        return;
      }

      // Store keys securely
      if (window.pcm?.keys) {
        await window.pcm.keys.store(JSON.stringify({
          publicKey: publicKeyB64,
          identitySecret: privateKeyB64,
          displayName: displayName.trim(),
          signedPreKey: {
            keyId: 1,
            publicKey: naclUtil.default.encodeBase64(signedPreKeyPair.publicKey),
            privateKey: naclUtil.default.encodeBase64(signedPreKeyPair.secretKey),
            signature: naclUtil.default.encodeBase64(signedPreKeySignature),
          },
          oneTimePreKeys,
          serverUrl,
        }));
      }

      setGeneratedKeys({ publicKey: publicKeyB64, privateKey: privateKeyB64 });

      login({
        userId: result.data.userId,
        publicKey: publicKeyB64,
        secretKey: privateKeyB64,
        token: result.data.token,
        refreshToken: result.data.refreshToken,
        displayName: displayName.trim(),
        serverUrl,
      });
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!privateKeyInput.trim()) {
      setError('Enter your private key');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const nacl = await import('tweetnacl');
      const naclUtil = await import('tweetnacl-util');
      const existingRaw = await window.pcm?.keys.load?.();
      const existingKeys = existingRaw ? JSON.parse(existingRaw) as Record<string, any> : {};

      const secretKey = naclUtil.default.decodeBase64(privateKeyInput.trim());
      const keyPair = nacl.default.sign.keyPair.fromSecretKey(secretKey);
      const publicKeyB64 = naclUtil.default.encodeBase64(keyPair.publicKey);

      // Request challenge
      const challengeRes = await fetch(`${serverUrl}/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: publicKeyB64 }),
      });

      const challengeResult = await challengeRes.json() as { success: boolean; data?: { nonce: string }; error?: { message?: string } };
      if (!challengeResult.success || !challengeResult.data) {
        setError(challengeResult.error?.message || 'Challenge request failed');
        return;
      }

      // Sign the nonce
      const nonce = challengeResult.data.nonce;
      const nonceBytes = naclUtil.default.decodeUTF8(nonce);
      const signature = nacl.default.sign.detached(nonceBytes, secretKey);
      const signatureB64 = naclUtil.default.encodeBase64(signature);

      // Verify
      const verifyRes = await fetch(`${serverUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: publicKeyB64,
          signature: signatureB64,
          timestamp: Date.now(),
        }),
      });

      const verifyResult = await verifyRes.json() as {
        success: boolean;
        data?: { userId: string; token: string; refreshToken: string };
        error?: { message?: string };
      };
      if (!verifyResult.success || !verifyResult.data) {
        setError(verifyResult.error?.message || 'Verification failed');
        return;
      }

      // Store keys securely
      if (window.pcm?.keys) {
        await window.pcm.keys.store(JSON.stringify({
          publicKey: publicKeyB64,
          identitySecret: privateKeyInput.trim(),
          displayName: existingKeys.displayName || existingKeys.profileName || 'User',
          signedPreKey: existingKeys.signedPreKey,
          oneTimePreKeys: existingKeys.oneTimePreKeys || [],
          serverUrl,
        }));
      }

      login({
        userId: verifyResult.data.userId,
        publicKey: publicKeyB64,
        secretKey: privateKeyInput.trim(),
        token: verifyResult.data.token,
        refreshToken: verifyResult.data.refreshToken,
        displayName: existingKeys.displayName || existingKeys.profileName || 'User',
        serverUrl,
      });
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-screen__orb auth-screen__orb--primary" />
      <div className="auth-screen__orb auth-screen__orb--accent" />
      <div className="auth-card">
        <div className="auth-card__logo">
          {Icons.key}
        </div>
        <div className="auth-card__title">PCM</div>
        <div className="auth-card__subtitle">
          {mode === 'register'
            ? 'Create your identity. Your keys are your passport — store them safely.'
            : 'Sign in with your private key.'}
        </div>

        {error && <div className="auth-alert auth-alert--error">{error}</div>}

        <input
          className="auth-input"
          placeholder="Server URL"
          value={serverUrl}
          onChange={e => setServerUrl(e.target.value)}
        />

        {mode === 'register' ? (
          <>
            <input
              className="auth-input"
              placeholder="Display name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              maxLength={32}
            />
            <button className="auth-btn" onClick={handleRegister} disabled={loading}>
              {loading ? 'Generating keys...' : 'Create Identity'}
            </button>
            {generatedKeys && (
              <div className="auth-key-stack">
                <div>
                  <div className="auth-key-label">Private Key (save this)</div>
                  <div className="auth-key-display">{generatedKeys.privateKey}</div>
                </div>
                <div>
                  <div className="auth-key-label auth-key-label--spaced">Public Key</div>
                  <div className="auth-key-display">{generatedKeys.publicKey}</div>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <textarea
              className="auth-input auth-input--textarea auth-input--mono"
              placeholder="Paste your private key (base64)"
              value={privateKeyInput}
              onChange={e => setPrivateKeyInput(e.target.value)}
            />
            <button className="auth-btn" onClick={handleLogin} disabled={loading}>
              {loading ? 'Verifying...' : 'Sign In'}
            </button>
          </>
        )}

        <div className="auth-toggle">
          {mode === 'register' ? (
            <>Already have a key? <a onClick={() => setMode('login')}>Sign in</a></>
          ) : (
            <>New here? <a onClick={() => setMode('register')}>Create identity</a></>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// New Chat Dialog
// ============================================================
function NewChatDialog({ onClose }: { onClose: () => void }) {
  const [publicKeyInput, setPublicKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [foundUser, setFoundUser] = useState<{ id: string; displayName: string; publicKey: string } | null>(null);
  const addConversation = useConversationsStore(s => s.addConversation);
  const setActiveConversation = useConversationsStore(s => s.setActiveConversation);
  const resetUnread = useConversationsStore(s => s.resetUnread);
  const userId = useAuthStore(s => s.userId);

  const handleSearch = async () => {
    if (!publicKeyInput.trim()) return;
    setLoading(true);
    setError('');
    setFoundUser(null);

    try {
      const result = await getUserByPublicKey(publicKeyInput.trim());
      if (!result.success) {
        setError(result.error?.message || 'User not found');
        return;
      }
      if (!result.data) {
        setError('User not found');
        return;
      }
      if (result.data.id === userId) {
        setError('That\'s your own key!');
        return;
      }
      setFoundUser(result.data);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleStartChat = async () => {
    if (!foundUser) return;
    setLoading(true);
    try {
      const result = await createConversation({ type: 'direct', memberIds: [foundUser.id] });
      if (!result.success) {
        setError(result.error?.message || 'Failed to create chat');
        return;
      }

      if (!userId) throw new Error('You must be logged in');

      if (!result.data) {
        throw new Error('Conversation was not created');
      }
      const conv = result.data;
      addConversation(conv);
      resetUnread(conv.id);
      setActiveConversation(conv.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create chat');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--compact" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">New Chat</h2>
          <button className="sidebar__btn" onClick={onClose}>{Icons.close}</button>
        </div>

        <div className="modal__subtitle">
          Paste the public key of the person you want to chat with.
        </div>

        {error && (
          <div className="auth-alert auth-alert--error modal__alert">
            {error}
          </div>
        )}

        <textarea
          className="auth-input auth-input--textarea auth-input--mono modal__textarea"
          placeholder="Paste public key (base64)"
          value={publicKeyInput}
          onChange={e => setPublicKeyInput(e.target.value)}
        />

        <button className="auth-btn modal__action" onClick={handleSearch} disabled={loading || !publicKeyInput.trim()}>
          {loading ? 'Searching...' : 'Find User'}
        </button>

        {foundUser && (
          <div className="found-user-card">
            <div className="chat-item__avatar found-user-card__avatar">
              {getInitials(foundUser.displayName)}
            </div>
            <div className="found-user-card__body">
              <div className="found-user-card__name">{foundUser.displayName}</div>
              <div className="found-user-card__key">
                {foundUser.publicKey.slice(0, 24)}...
              </div>
            </div>
            <button
              className="auth-btn"
              style={{ width: 'auto', padding: '0 20px', height: 40, marginTop: 0 }}
              onClick={handleStartChat}
              disabled={loading}
            >
              Chat
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Emoji Picker Component
// ============================================================
function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  return (
    <div className="emoji-panel">
      <div className="emoji-panel__header">
        <span>Emojis</span>
        <button onClick={onClose}>{Icons.close}</button>
      </div>
      <div className="emoji-panel__grid">
        {EMOJIS.map(emoji => (
          <button
            key={emoji}
            className="emoji-panel__item"
            onClick={() => onSelect(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Sidebar Component
// ============================================================
function Sidebar() {
  const [showNewChat, setShowNewChat] = useState(false);
  const conversations = useConversationsStore(s => s.conversations);
  const activeConversationId = useConversationsStore(s => s.activeConversationId);
  const setActiveConversation = useConversationsStore(s => s.setActiveConversation);
  const presence = usePresenceStore(s => s.presence);
  const searchQuery = useUIStore(s => s.searchQuery);
  const setSearchQuery = useUIStore(s => s.setSearchQuery);
  const setShowSettings = useUIStore(s => s.setShowSettings);
  const userId = useAuthStore(s => s.userId);

  const filteredConversations = conversations.filter(c =>
    !searchQuery || (c.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <button className="sidebar__btn" onClick={() => setShowSettings(true)} title="Menu">
          {Icons.menu}
        </button>
        <div className="sidebar__search">
          <span className="sidebar__search-icon">{Icons.search}</span>
          <input
            placeholder="Search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="chat-list">
        {filteredConversations.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
            <div style={{ fontSize: 'var(--font-size-sm)' }}>
              {conversations.length === 0 ? 'No conversations yet' : 'No results found'}
            </div>
          </div>
        ) : (
          filteredConversations.map(conv => {
            const otherMemberId = conv.type === ConversationType.DIRECT
              ? conv.members.find(m => m !== userId) || ''
              : '';
            const isOnline = otherMemberId && presence[otherMemberId]?.status === UserStatus.ONLINE;
            const isActive = conv.id === activeConversationId;

            return (
              <div
                key={conv.id}
                className={`chat-item ${isActive ? 'chat-item--active' : ''}`}
                onClick={() => {
                  setShowSettings(false);
                  setActiveConversation(conv.id);
                }}
              >
                <div className="chat-item__avatar" style={{ position: 'relative' }}>
                  {conv.avatar ? (
                    <img src={conv.avatar} alt="" />
                  ) : (
                    getInitials(conv.name || 'Chat')
                  )}
                  {isOnline && <span className="online-indicator" />}
                </div>
                <div className="chat-item__content">
                  <div className="chat-item__header">
                    <span className="chat-item__name">{conv.name || 'Chat'}</span>
                    {conv.lastMessageAt && (
                      <span className="chat-item__time">{formatTime(conv.lastMessageAt)}</span>
                    )}
                  </div>
                  <div className="chat-item__preview">
                    {conv.lastMessage ? (
                      <>
                        {conv.lastMessage.senderId === userId && (
                          <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>You: </span>
                        )}
                        {conv.lastMessage.text?.slice(0, 40) || '📎 Media'}
                      </>
                    ) : (
                      <span style={{ fontStyle: 'italic' }}>No messages yet</span>
                    )}
                  </div>
                </div>
                {conv.unreadCount > 0 && (
                  <span className="chat-item__badge">{conv.unreadCount}</span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Floating New Chat Button */}
      <button className="sidebar__fab" onClick={() => setShowNewChat(true)} title="New Chat">
        {Icons.plus}
      </button>

      {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} />}
    </div>
  );
}

// ============================================================
// Chat Header
// ============================================================
function ChatHeader({ conversation }: { conversation: Conversation }) {
  const presence = usePresenceStore(s => s.presence);
  const userId = useAuthStore(s => s.userId);
  const showMessageSearch = useUIStore(s => s.showMessageSearch);
  const setShowMessageSearch = useUIStore(s => s.setShowMessageSearch);
  const messageSearchQuery = useUIStore(s => s.messageSearchQuery);
  const setMessageSearchQuery = useUIStore(s => s.setMessageSearchQuery);

  const otherMemberId = conversation.type === ConversationType.DIRECT
    ? conversation.members.find(m => m !== userId) || ''
    : '';
  const userPresence = otherMemberId ? presence[otherMemberId] : null;

  const statusText = conversation.type === ConversationType.GROUP
    ? `${conversation.members.length} members`
    : userPresence?.status === UserStatus.ONLINE
      ? 'online'
      : userPresence?.lastSeen
        ? `last seen ${formatTime(userPresence.lastSeen)}`
        : 'offline';

  const isOnline = userPresence?.status === UserStatus.ONLINE;

  return (
    <div className="chat-header">
      <div className="chat-item__avatar chat-header__avatar">
        {getInitials(conversation.name || 'Chat')}
      </div>
      <div className="chat-header__info">
        {showMessageSearch ? (
          <div className="sidebar__search chat-header__search">
            <span className="sidebar__search-icon">{Icons.search}</span>
            <input
              autoFocus
              placeholder="Search in chat..."
              value={messageSearchQuery}
              onChange={e => setMessageSearchQuery(e.target.value)}
            />
            <button onClick={() => { setShowMessageSearch(false); setMessageSearchQuery(''); }}>{Icons.close}</button>
          </div>
        ) : (
          <>
            <div className="chat-header__name">{conversation.name || 'Chat'}</div>
            <div className={`chat-header__status ${isOnline ? 'chat-header__status--online' : ''}`}>
              {statusText}
            </div>
          </>
        )}
      </div>
      <div className="chat-header__actions">
        <button className="chat-header__btn" title="Audio call" onClick={() => callService.initiateCall(conversation.id, otherMemberId, CallType.AUDIO)}>{Icons.phone}</button>
        <button className="chat-header__btn" title="Video call" onClick={() => callService.initiateCall(conversation.id, otherMemberId, CallType.VIDEO)}>{Icons.video}</button>
        <button 
          className={`chat-header__btn ${showMessageSearch ? 'chat-header__btn--active' : ''}`} 
          onClick={() => setShowMessageSearch(!showMessageSearch)}
          title="Search"
        >
          {Icons.search}
        </button>
        <button className="chat-header__btn" title="More">{Icons.moreVert}</button>
      </div>
    </div>
  );
}

// ============================================================
// Message Bubble
// ============================================================
function MessageBubble({ message, isOwn, showSender }: { message: DecryptedMessage; isOwn: boolean; showSender: boolean }) {
  const statusIcon = isOwn ? (
    message.status === MessageStatus.READ ? (
      <span className="message-bubble__status message-bubble__status--read">{Icons.checkDouble}</span>
    ) : message.status === MessageStatus.DELIVERED ? (
      <span className="message-bubble__status">{Icons.checkDouble}</span>
    ) : message.status === MessageStatus.SENT ? (
      <span className="message-bubble__status">{Icons.check}</span>
    ) : null
  ) : null;

  return (
    <div className={`message-bubble ${isOwn ? 'message-bubble--own' : 'message-bubble--other'}`}>
      {showSender && !isOwn && (
        <div className="message-bubble__sender">{message.senderId.slice(0, 8)}</div>
      )}

      {message.media && (message.type === MessageType.IMAGE || message.type === MessageType.VIDEO) && (
        <div className="message-media">
          {message.type === MessageType.IMAGE ? (
            <img src={message.media.thumbnailUrl || ''} alt="" loading="lazy" />
          ) : (
            <video src={message.media.thumbnailUrl || ''} controls />
          )}
        </div>
      )}

      {message.type === MessageType.VOICE && (
        <div className="voice-message">
          <button className="voice-message__btn">{Icons.play}</button>
          <div className="voice-message__waveform">
            {Array.from({ length: 28 }, (_, i) => (
              <div
                key={i}
                className="voice-message__bar"
                style={{ height: `${Math.random() * 20 + 8}px` }}
              />
            ))}
          </div>
          <span className="voice-message__duration">
            {message.media?.duration ? `${Math.floor(message.media.duration / 60)}:${String(Math.floor(message.media.duration % 60)).padStart(2, '0')}` : '0:00'}
          </span>
        </div>
      )}

      {message.text && (
        <div className="message-bubble__text">{message.text}</div>
      )}

      <div className="message-bubble__footer">
        <span className="message-bubble__time">{formatTime(message.timestamp)}</span>
        {statusIcon}
      </div>
    </div>
  );
}

// ============================================================
// Messages Area
// ============================================================
function MessagesArea({ conversationId }: { conversationId: string }) {
  const messages = useMessagesStore(s => s.messages[conversationId] || EMPTY_ARRAY);
  const userId = useAuthStore(s => s.userId);
  const typingUsers = useUIStore(s => s.typingUsers[conversationId] || EMPTY_ARRAY);
  const messageSearchQuery = useUIStore(s => s.messageSearchQuery || '');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const filteredMessages = messageSearchQuery
    ? messages.filter(m => m.text?.toLowerCase().includes(messageSearchQuery.toLowerCase()))
    : messages;

  const groupedMessages = groupMessagesByDate(filteredMessages);

  return (
    <div className="messages-area">
      <div className="messages-area__content">
        {filteredMessages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              {messageSearchQuery ? 'No messages found' : Icons.lock}
              {!messageSearchQuery && <span>Messages are end-to-end encrypted</span>}
            </div>
          </div>
        ) : (
          groupedMessages.map(group => (
            <div key={group.date}>
              <div className="date-separator">
                <span className="date-separator__label">{group.date}</span>
              </div>
              {group.messages.map((msg, i) => {
                const isOwn = msg.senderId === userId;
                const prevMsg = i > 0 ? group.messages[i - 1] : null;
                const showSender = !prevMsg || prevMsg.senderId !== msg.senderId;

                return (
                  <MessageBubble key={msg.id} message={msg} isOwn={isOwn} showSender={showSender} />
                );
              })}
            </div>
          ))
        )}


        {typingUsers.length > 0 && (
          <div className="typing-indicator">
            <div className="typing-dots">
              <span /><span /><span />
            </div>
            <span>{typingUsers.length === 1 ? 'typing...' : `${typingUsers.length} people typing...`}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

// ============================================================
// Message Input
// ============================================================
function MessageInput({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const userId = useAuthStore(s => s.userId);
  const addMessage = useMessagesStore(s => s.addMessage);
  const updateLastMessage = useConversationsStore(s => s.updateLastMessage);
  const replyingTo = useUIStore(s => s.replyingTo);
  const setReplyingTo = useUIStore(s => s.setReplyingTo);
  const showEmojiPanel = useUIStore(s => s.showEmojiPanel);
  const setShowEmojiPanel = useUIStore(s => s.setShowEmojiPanel);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      alert('File is too large! Please choose an image under 2MB.');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const base64Url = evt.target?.result as string;
      if (!base64Url || !userId) return;

      const ws = getWSService();
      if (!ws) return;

      const conv = useConversationsStore.getState().conversations.find(c => c.id === conversationId);
      if (!conv) return;

      try {
        const recipientId = conv.members.find(m => m !== userId);
        if (!recipientId) return;
        const messageId = uuid();

        let session = useSessionStore.getState().sessions[conversationId];
        let x3dhEphemeralKey: Uint8Array | undefined;
        
        if (!session) {
          const bundle = await ws.requestKeyBundle(recipientId);
          if (!bundle || !bundle.signedPreKey) throw new Error('Recipient has no signed pre-key.');

          const mySecretKeyB64 = useAuthStore.getState().secretKey;
          if (!mySecretKeyB64) throw new Error('Missing secret key');
          
          const mySecretKey = naclUtil.decodeBase64(mySecretKeyB64);
          const { sharedSecret, ephemeralKeyPair, oneTimePreKeyId } = x3dhInitiate(mySecretKey, bundle);
          x3dhEphemeralKey = ephemeralKeyPair.publicKey;
          
          session = DoubleRatchetSession.initAsAlice(sharedSecret, naclUtil.decodeBase64(bundle.signedPreKey.publicKey));
          useSessionStore.getState().setSession(conversationId, session);
          
          const encrypted = session.encrypt(base64Url, x3dhEphemeralKey, oneTimePreKeyId);
          ws.sendMessage({
            id: messageId,
            conversationId,
            recipientIds: [recipientId],
            encryptedPayloads: { [recipientId]: encrypted as any },
            messageType: MessageType.IMAGE,
            timestamp: Date.now(),
          });
          
          const msg: DecryptedMessage = {
            id: messageId,
            conversationId,
            senderId: userId,
            type: MessageType.IMAGE,
            media: { thumbnailUrl: base64Url } as any,
            status: MessageStatus.SENT,
            timestamp: Date.now(),
          };
          addMessage(conversationId, msg);
          updateLastMessage(conversationId, msg);
          return;
        }

        const encrypted = session.encrypt(base64Url, x3dhEphemeralKey);
        ws.sendMessage({
          id: messageId,
          conversationId,
          recipientIds: [recipientId],
          encryptedPayloads: { [recipientId]: encrypted as any },
          messageType: MessageType.IMAGE,
          timestamp: Date.now(),
        });

        const msg: DecryptedMessage = {
          id: messageId,
          conversationId,
          senderId: userId,
          type: MessageType.IMAGE,
          media: { thumbnailUrl: base64Url } as any,
          status: MessageStatus.SENT,
          timestamp: Date.now(),
        };
        addMessage(conversationId, msg);
        updateLastMessage(conversationId, msg);
      } catch (err) {
        console.error('[Send Image] Failed:', err);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = ''; 
  };


  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !userId) return;

    const ws = getWSService();
    if (!ws) return;

    const conv = useConversationsStore.getState().conversations.find(c => c.id === conversationId);
    if (!conv) return;

    try {
      const recipientId = conv.members.find(m => m !== userId);
      if (!recipientId) return;
      const messageId = uuid();

      let session = useSessionStore.getState().sessions[conversationId];
      let x3dhEphemeralKey: Uint8Array | undefined;
      
      // If no session, perform X3DH Handshake
      if (!session) {
        console.log('[Crypto] No session found. Initiating X3DH with', recipientId);
        const bundle = await ws.requestKeyBundle(recipientId);
        console.log('[Crypto] Received Key Bundle from server:', bundle);

        if (!bundle || !bundle.signedPreKey) {
           throw new Error('Recipient has no signed pre-key. Encryption cannot start.');
        }

        const mySecretKeyB64 = useAuthStore.getState().secretKey;
        if (!mySecretKeyB64) throw new Error('Your secret key is missing (not logged in properly?)');
        
        console.log('[Crypto] Keys found. Calculating shared secret...');
        const mySecretKey = naclUtil.decodeBase64(mySecretKeyB64);
        const { sharedSecret, ephemeralKeyPair, oneTimePreKeyId } = x3dhInitiate(mySecretKey, bundle);
        x3dhEphemeralKey = ephemeralKeyPair.publicKey;
        
        console.log('[Crypto] Shared secret derived. Initializing Double Ratchet...');
        session = DoubleRatchetSession.initAsAlice(sharedSecret, naclUtil.decodeBase64(bundle.signedPreKey.publicKey));
        useSessionStore.getState().setSession(conversationId, session);
        const encrypted = session.encrypt(trimmed, x3dhEphemeralKey, oneTimePreKeyId);
        
        // Send
        console.log('[WS] Sending encrypted payload via WebSocket...');
        ws.sendMessage({
          id: messageId,
          conversationId,
          recipientIds: [recipientId],
          encryptedPayloads: { [recipientId]: encrypted as any },
          messageType: MessageType.TEXT,
          timestamp: Date.now(),
        });
        console.log('[WS] Message sent successfully!');

        const message: DecryptedMessage = {
          id: messageId,
          conversationId,
          senderId: userId,
          type: MessageType.TEXT,
          text: trimmed,
          status: MessageStatus.SENT,
          timestamp: Date.now(),
          replyToId: replyingTo?.id,
        };

        addMessage(conversationId, message);
        updateLastMessage(conversationId, message);
        setText('');
        setReplyingTo(null);
        setShowEmojiPanel(false);
        textareaRef.current?.focus();
        return;
      }

      // Encrypt
      console.log('[Crypto] Encrypting message text...');
      const encrypted = session.encrypt(trimmed, x3dhEphemeralKey);
      
      // Send
      console.log('[WS] Sending encrypted payload via WebSocket...');
      ws.sendMessage({
        id: messageId,
        conversationId,
        recipientIds: [recipientId],
        encryptedPayloads: { [recipientId]: encrypted as any },
        messageType: MessageType.TEXT,
        timestamp: Date.now(),
      });
      console.log('[WS] Message sent successfully!');

      // Update Local stores (temp message showing)
      const message: DecryptedMessage = {
        id: messageId,
        conversationId,
        senderId: userId,
        type: MessageType.TEXT,
        text: trimmed,
        status: MessageStatus.SENT,
        timestamp: Date.now(),
        replyToId: replyingTo?.id,
      };

      addMessage(conversationId, message);
      updateLastMessage(conversationId, message);
    } catch (err: any) {
      console.error('[Send] Failed:', err);
      // Show error in UI?
    }

    setText('');
    setReplyingTo(null);
    setShowEmojiPanel(false);
    textareaRef.current?.focus();
  }, [text, userId, conversationId, replyingTo, addMessage, updateLastMessage, setReplyingTo, setShowEmojiPanel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [text]);

  useEffect(() => {
    setShowEmojiPanel(false);
  }, [conversationId, setShowEmojiPanel]);

  return (
    <>
      {replyingTo && (
        <div className="reply-preview">
          <div className="reply-preview__bar" />
          <div className="reply-preview__content">
            <div className="reply-preview__name">{replyingTo.senderId.slice(0, 8)}</div>
            <div className="reply-preview__text">{replyingTo.text?.slice(0, 60) || '📎 Media'}</div>
          </div>
          <button className="reply-preview__close" onClick={() => setReplyingTo(null)}>
            {Icons.close}
          </button>
        </div>
      )}
      <div className="message-input">
        <div style={{ position: 'relative' }}>
          <button 
            className={`message-input__btn ${showEmojiPanel ? 'message-input__btn--active' : ''}`} 
            onClick={() => setShowEmojiPanel(!showEmojiPanel)}
            title="Emoji"
          >
            {Icons.emoji}
          </button>
          {showEmojiPanel && (
            <EmojiPicker 
              onSelect={(emoji) => setText(prev => prev + emoji)} 
              onClose={() => setShowEmojiPanel(false)} 
            />
          )}
        </div>
        <div className="message-input__area">
          <textarea
            ref={textareaRef}
            className="message-input__textarea"
            placeholder="Message"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <input 
            type="file" 
            accept="image/*" 
            style={{ display: 'none' }} 
            ref={fileInputRef} 
            onChange={handleFileChange} 
          />
          <button className="message-input__btn" title="Attach file" onClick={() => fileInputRef.current?.click()}>
            {Icons.attach}
          </button>
        </div>
        {text.trim() ? (
          <button className="message-input__btn message-input__btn--send" onClick={handleSend} title="Send">
            {Icons.send}
          </button>
        ) : (
          <button className="message-input__btn" title="Voice message">
            {Icons.mic}
          </button>
        )}
      </div>
    </>
  );
}

// ============================================================
// Chat View
// ============================================================
function ChatView() {
  const activeConversationId = useConversationsStore(s => s.activeConversationId);
  const conversations = useConversationsStore(s => s.conversations);
  const resetUnread = useConversationsStore(s => s.resetUnread);
  const setShowSettings = useUIStore(s => s.setShowSettings);
  const setShowMessageSearch = useUIStore(s => s.setShowMessageSearch);
  const setMessageSearchQuery = useUIStore(s => s.setMessageSearchQuery);

  const activeConversation = conversations.find(c => c.id === activeConversationId);

  useEffect(() => {
    if (!activeConversationId) return;
    resetUnread(activeConversationId);
    setShowSettings(false);
    setShowMessageSearch(false);
    setMessageSearchQuery('');
  }, [activeConversationId, resetUnread, setShowMessageSearch, setMessageSearchQuery, setShowSettings]);

  if (!activeConversation) {
    return (
      <div className="chat-view chat-view--empty">
        <div className="chat-view__empty-state">
          <div className="chat-view__empty-icon">{Icons.shield}</div>
          <div className="chat-view__empty-text">Select a chat to start messaging</div>
          <div className="chat-view__empty-subtext">
            All messages are end-to-end encrypted
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <ChatHeader conversation={activeConversation} />
      <MessagesArea conversationId={activeConversation.id} />
      <MessageInput conversationId={activeConversation.id} />
    </div>
  );
}

// ============================================================
// Settings Panel
// ============================================================
function SettingsPanel() {
  type SettingsView = 'root' | 'privacy' | 'appearance';
  type FontSizePreset = 'small' | 'medium' | 'large';
  type SidebarPreset = 'compact' | 'default' | 'wide';

  const setShowSettings = useUIStore(s => s.setShowSettings);
  const displayName = useAuthStore(s => s.displayName);
  const publicKey = useAuthStore(s => s.publicKey);
  const login = useAuthStore(s => s.login);
  const logout = useAuthStore(s => s.logout);
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState(displayName || '');
  const [newStatus, setNewStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const secretKey = useAuthStore(s => s.secretKey);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const [view, setView] = useState<SettingsView>('root');
  const [fontSizePreset, setFontSizePreset] = useState<FontSizePreset>(() => (localStorage.getItem('pcm:appearance:fontSize') as FontSizePreset | null) || 'medium');
  const [sidebarPreset, setSidebarPreset] = useState<SidebarPreset>(() => (localStorage.getItem('pcm:appearance:sidebar') as SidebarPreset | null) || 'default');

  const applyAppearance = useCallback((fontSize: FontSizePreset, sidebar: SidebarPreset) => {
    const root = document.documentElement;
    const fontSizeMap: Record<FontSizePreset, string> = { small: '13px', medium: '14px', large: '16px' };
    const sidebarMap: Record<SidebarPreset, string> = { compact: '340px', default: '380px', wide: '420px' };

    root.style.setProperty('--font-size-md', fontSizeMap[fontSize]);
    root.style.setProperty('--sidebar-width', sidebarMap[sidebar]);
    localStorage.setItem('pcm:appearance:fontSize', fontSize);
    localStorage.setItem('pcm:appearance:sidebar', sidebar);
  }, []);

  useEffect(() => {
    applyAppearance(fontSizePreset, sidebarPreset);
  }, [applyAppearance, fontSizePreset, sidebarPreset]);

  const handleUpdate = async () => {
    setLoading(true);
    try {
      const res = await updateProfile({ displayName: newName, customStatus: newStatus });
      if (res.success) {
        await persistLocalKeys({ displayName: newName });
        login({ ...useAuthStore.getState() as any, displayName: newName });
        setEditing(false);
      }
    } catch (err) {
      logError('Settings', 'Update failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button className="settings-backdrop" onClick={() => setShowSettings(false)} aria-label="Close settings" />
      <div className="settings-panel">
        <div className="settings-panel__header">
          <button className="sidebar__btn" onClick={() => view === 'root' ? setShowSettings(false) : setView('root')}>
            {Icons.back}
          </button>
          <span className="settings-panel__title">{view === 'root' ? 'Settings' : view === 'privacy' ? 'Privacy & Security' : 'Appearance'}</span>
        </div>

        {view === 'root' && (
          <>
            <div className="settings-profile">
              <div className="chat-item__avatar settings-profile__avatar">
                {getInitials(displayName || 'User')}
              </div>
              {editing ? (
                <div className="settings-profile__editor">
                  <input className="auth-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Display Name" />
                  <input className="auth-input" value={newStatus} onChange={e => setNewStatus(e.target.value)} placeholder="Custom Status" />
                  <div className="settings-profile__actions">
                    <button className="auth-btn settings-profile__action" onClick={handleUpdate} disabled={loading}>Save</button>
                    <button className="auth-btn settings-profile__action settings-profile__action--secondary" onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="settings-profile__name">{displayName}</div>
                  <div
                    className="settings-profile__key"
                    onClick={() => publicKey && navigator.clipboard.writeText(publicKey)}
                    title="Click to copy full public key"
                  >
                    <div className="settings-profile__key-row">
                      {Icons.copy}
                      <span>{publicKey?.slice(0, 32)}...</span>
                    </div>
                  </div>
                  <div className="settings-profile__actions">
                    <button className="sidebar__btn settings-profile__pill" onClick={() => setEditing(true)}>Edit Profile</button>
                    <button className="sidebar__btn settings-profile__pill settings-profile__pill--primary" onClick={() => publicKey && navigator.clipboard.writeText(publicKey)}>Copy Full Key</button>
                  </div>
                </>
              )}
            </div>

            <div className="settings-section">
              <div className="settings-section__title">General</div>
              <button className="settings-item settings-item--button" onClick={() => setView('privacy')}>
                <div className="settings-item__icon">{Icons.lock}</div>
                <span className="settings-item__label">Privacy & Security</span>
              </button>
              <button className="settings-item settings-item--button" onClick={() => setView('appearance')}>
                <div className="settings-item__icon">{Icons.settings}</div>
                <span className="settings-item__label">Appearance</span>
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section__title">Account</div>
              <div className="settings-item" onClick={() => secretKey && navigator.clipboard.writeText(secretKey)}>
                <div className="settings-item__icon">{Icons.key}</div>
                <span className="settings-item__label">Copy Private Key</span>
              </div>
              <div className="settings-item settings-item--static">
                <div className="settings-item__icon">{Icons.user}</div>
                <span className="settings-item__label">Server</span>
                <span className="settings-item__value">{serverUrl}</span>
              </div>
              <div className="settings-item" onClick={logout}>
                <div className="settings-item__icon settings-item__icon--danger">{Icons.close}</div>
                <span className="settings-item__label settings-item__label--danger">Log Out</span>
              </div>
            </div>
          </>
        )}

        {view === 'privacy' && (
          <div className="settings-section">
            <div className="settings-section__title">Privacy & Security</div>
            <button className="settings-item settings-item--button" onClick={() => publicKey && navigator.clipboard.writeText(publicKey)}>
              <div className="settings-item__icon">{Icons.copy}</div>
              <span className="settings-item__label">Copy Public Key</span>
            </button>
            <button className="settings-item settings-item--button" onClick={() => secretKey && navigator.clipboard.writeText(secretKey)}>
              <div className="settings-item__icon">{Icons.key}</div>
              <span className="settings-item__label">Copy Private Key</span>
            </button>
            <button className="settings-item settings-item--button" onClick={() => serverUrl && navigator.clipboard.writeText(serverUrl)}>
              <div className="settings-item__icon">{Icons.user}</div>
              <span className="settings-item__label">Copy Server URL</span>
            </button>
            <div className="settings-item settings-item--static">
              <div className="settings-item__icon">{Icons.lock}</div>
              <div className="settings-item__stack">
                <span className="settings-item__label">Key Storage</span>
                <span className="settings-item__hint">Desktop keys use encrypted local storage via Electron safe storage.</span>
              </div>
            </div>
          </div>
        )}

        {view === 'appearance' && (
          <div className="settings-section">
            <div className="settings-section__title">Appearance</div>
            <div className="settings-option-group">
              <div className="settings-option-group__label">Font Size</div>
              <div className="settings-choice-row">
                {(['small', 'medium', 'large'] as FontSizePreset[]).map((size) => (
                  <button key={size} className={`settings-choice ${fontSizePreset === size ? 'settings-choice--active' : ''}`} onClick={() => setFontSizePreset(size)}>
                    {size}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-option-group">
              <div className="settings-option-group__label">Sidebar Width</div>
              <div className="settings-choice-row">
                {(['compact', 'default', 'wide'] as SidebarPreset[]).map((size) => (
                  <button key={size} className={`settings-choice ${sidebarPreset === size ? 'settings-choice--active' : ''}`} onClick={() => setSidebarPreset(size)}>
                    {size}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// Call Overlay Components
// ============================================================
function ParticipantCard({ userId, stream, isLocal }: { userId: string; stream: MediaStream | null; isLocal?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayName = usePresenceStore.getState().presence[userId]?.customStatus || (isLocal ? 'You' : userId.slice(0, 8));

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="participant-card">
      {stream && stream.getVideoTracks().length > 0 ? (
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="participant-card__video" />
      ) : (
        <div className="participant-card__placeholder">
          <div className="participant-card__avatar">{getInitials(displayName)}</div>
          <div className="participant-card__name">{displayName}</div>
        </div>
      )}
      <div className="participant-card__name participant-card__name--overlay">
        {displayName} {isLocal && '(You)'}
      </div>
    </div>
  );
}

function CallOverlay() {
  const activeCall = useCallStore(s => s.activeCall);
  const remoteStreams = useCallStore(s => s.remoteStreams);
  const isMuted = useCallStore(s => s.isMuted);
  const isVideoEnabled = useCallStore(s => s.isVideoEnabled);
  const toggleMute = useCallStore(s => s.toggleMute);
  const toggleVideo = useCallStore(s => s.toggleVideo);
  
  if (!activeCall) return null;

  const participants = Object.entries(remoteStreams);
  const gridClass = participants.length === 0 ? 'call-grid--1' : 
                   participants.length === 1 ? 'call-grid--2' :
                   participants.length <= 4 ? 'call-grid--3' : 'call-grid--many';

  const handleHangup = () => {
    callService.endCall();
  };

  const handleToggleMute = () => {
    callService.toggleMute();
    toggleMute();
  };

  const handleToggleVideo = () => {
    callService.toggleVideo();
    toggleVideo();
  };


  return (
    <div className="call-overlay">
      <div className="call-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {Icons.lock}
          <span>End-to-End Encrypted Group Call</span>
        </div>
      </div>

      <div className={`call-grid ${gridClass}`}>
        {/* Local Stream */}
        <ParticipantCard 
          userId={useAuthStore.getState().userId || ''} 
          stream={callService.getLocalStream()} 
          isLocal 
        />

        
        {/* Remote Streams */}
        {participants.map(([uid, stream]) => (
          <ParticipantCard key={uid} userId={uid} stream={stream} />
        ))}
      </div>

      <div className="call-controls">
        <button className={`call-btn ${isMuted ? 'call-btn--active' : ''}`} onClick={handleToggleMute}>
          {Icons.mic}
        </button>
        <button className={`call-btn ${!isVideoEnabled ? 'call-btn--active' : ''}`} onClick={handleToggleVideo}>
          {Icons.video}
        </button>
        <button className="call-btn call-btn--danger" onClick={handleHangup}>
          {Icons.phoneEnd}
        </button>
      </div>
    </div>
  );
}

function IncomingCallModal() {
  const incomingCall = useCallStore(s => s.incomingCall);
  if (!incomingCall) return null;

  const handleAccept = () => {
    callService.acceptCall(incomingCall.callId, incomingCall.initiatorId, incomingCall.type);
  };

  const handleReject = () => {
    callService.rejectCall(incomingCall.callId, incomingCall.initiatorId);
  };


  return (
    <div className="incoming-call-modal">
      <div className="incoming-call-modal__body">
        <div className="chat-item__avatar incoming-call-modal__avatar">
          {getInitials(incomingCall.initiatorId)}
        </div>
        <div>
          <div className="incoming-call-modal__name">{incomingCall.initiatorId.slice(0, 8)}...</div>
          <div className="incoming-call-modal__meta">
            Incoming {incomingCall.type} call
          </div>
        </div>
      </div>
      <div className="incoming-call-modal__actions">
        <button className="auth-btn incoming-call-modal__btn incoming-call-modal__btn--accept" onClick={handleAccept}>Accept</button>
        <button className="auth-btn incoming-call-modal__btn incoming-call-modal__btn--decline" onClick={handleReject}>Decline</button>
      </div>
    </div>
  );
}

export default function App() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const showSettings = useUIStore(s => s.showSettings);
  const userId = useAuthStore(s => s.userId);
  const token = useAuthStore(s => s.token);
  const refreshToken = useAuthStore(s => s.refreshToken);
  const serverUrl = useAuthStore(s => s.serverUrl);
  const activeConversationId = useConversationsStore(s => s.activeConversationId);
  const setConversations = useConversationsStore(s => s.setConversations);
  const setActiveConversation = useConversationsStore(s => s.setActiveConversation);

  // Try auto-login from stored keys

  useEffect(() => {
    (async () => {
      // Request notifications
      notifications.requestPermission();

      if (isAuthenticated) return;
      if (!window.pcm?.keys) return;

      const exists = await window.pcm.keys.exists();
      if (!exists) return;

      // Keys exist — could auto-login here in future
      // For now, user must manually login
    })();
  }, [isAuthenticated]);

  useEffect(() => {
    configureApi(resolveServerUrl(serverUrl), token || '');
  }, [serverUrl, token]);

  useEffect(() => {
    if (isAuthenticated) return;
    useConversationsStore.getState().reset();
    useMessagesStore.getState().reset();
    usePresenceStore.getState().reset();
    useCallStore.getState().reset();
    useSessionStore.getState().reset();
    useUIStore.getState().reset();
  }, [isAuthenticated]);

  // Auto-connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated && token) {
       const ws = getWSService();
       if (ws) {
         ws.updateToken(token);
         if (!ws.isConnected()) {
           ws.connect().catch(err => logError('WS', 'Connect failed:', err));
         }
         callService.bindToCurrentWS();
         return;
       }

       logDebug('WS', 'Authenticated but no socket. Connecting...');
       const nextWs = createWSService(resolveServerUrl(serverUrl), token);
       nextWs.connect().catch(err => logError('WS', 'Connect failed:', err));
       callService.bindToCurrentWS();
    } else if (!isAuthenticated) {
       getWSService()?.disconnect();
    }
  }, [isAuthenticated, token, serverUrl]);

  useEffect(() => {
    if (!isAuthenticated || !refreshToken) return;

    const refresh = async () => {
      const result = await refreshAuthToken(refreshToken);
      if (!result.success || !result.data?.token) {
        throw new Error(result.error?.message || 'Token refresh failed');
      }

      useAuthStore.getState().setToken(result.data.token);
      updateApiToken(result.data.token);
      getWSService()?.updateToken(result.data.token);
    };

    refresh().catch((err) => {
      logError('Auth', 'Initial token refresh failed:', err);
      useAuthStore.getState().logout();
    });

    const timer = window.setInterval(() => {
      refresh().catch((err) => {
        logError('Auth', 'Token refresh failed:', err);
        useAuthStore.getState().logout();
      });
    }, 10 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, refreshToken]);

  useEffect(() => {
    if (!isAuthenticated) return;

    (async () => {
      const result = await getConversations();
      if (!result.success || !result.data) return;

      setConversations(result.data);
      if (!useConversationsStore.getState().activeConversationId && result.data.length > 0) {
        setActiveConversation(result.data[0].id);
      }
    })().catch(err => logError('API', 'Failed to load conversations:', err));
  }, [isAuthenticated, setConversations, setActiveConversation]);

  // Notifications for new messages (Safe subscription method)
  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    return useMessagesStore.subscribe((state, prevState) => {
      // Logic: if total message count increased
      const prevTotal = Object.values(prevState.messages).flat().length;
      const currentTotal = Object.values(state.messages).flat().length;

      if (currentTotal > prevTotal) {
        const all = Object.values(state.messages).flat();
        const last = all[all.length - 1];
        if (last && last.senderId !== userId) {
          notifications.notify('New Message', {
            body: last.text || '📎 Sent a file',
            tag: last.conversationId,
          });
          notifications.playMessageSound();
        }
      }
    });
  }, [isAuthenticated, userId]);


  // WebSocket event listeners (Messages, Conversations, etc.)
  useEffect(() => {
    if (!isAuthenticated) return;
    const ws = getWSService();
    if (!ws) return;

    // Handle incoming conversations (for Bob)
    const handleConvCreate = (conv: Conversation) => {
      console.log('[App] New conversation received:', conv);
      useConversationsStore.getState().addConversation(conv);
      if (!useConversationsStore.getState().activeConversationId) {
        useConversationsStore.getState().setActiveConversation(conv.id);
      }
    };

    // Handle incoming messages & decryption
    const handleMessage = async (data: any) => {
      const { id, conversationId, senderId, content, type, timestamp } = data;
      console.log('[App] Message received from', senderId);
      
      try {
        let session = useSessionStore.getState().sessions[conversationId];
        
        // BOB SIDE: If no session, Bob must initialize it using Alice's Eph Key and Identity Key
        if (!session && content.x3dhEphemeralKey) {
           console.log('[Crypto] First message from Alice. Initializing session via X3DH (Bob side)...');
           
           const keysB64 = await window.pcm.keys.load();
           if (!keysB64) throw new Error('No local keys for Bob (cannot respond)');
           const myKeys = JSON.parse(keysB64);
           
           // Alice's public info (from message/bundle)
           const aliceEphemeral = naclUtil.decodeBase64(content.x3dhEphemeralKey);
           
           // In real Signal, Alice's bundle is fetched or her ID key is in message
           // Fetching Alice's keys
           const bundle = await ws.requestKeyBundle(senderId);
           const aliceIdentity = naclUtil.decodeBase64(bundle.identityKey);

           const oneTimePreKey = content.oneTimePreKeyId
             ? (myKeys.oneTimePreKeys || []).find((key: any) => key.keyId === content.oneTimePreKeyId)
             : null;

           const sharedSecret = x3dhRespond(
             naclUtil.decodeBase64(myKeys.identitySecret),
             naclUtil.decodeBase64(myKeys.signedPreKey.privateKey),
             oneTimePreKey ? naclUtil.decodeBase64(oneTimePreKey.privateKey) : null,
             aliceIdentity,
             aliceEphemeral
           );
           
           // Use Bob's signed pre-key as his initial ratchet key
           session = DoubleRatchetSession.initAsBob(sharedSecret, {
             publicKey: naclUtil.decodeBase64(myKeys.signedPreKey.publicKey),
             secretKey: naclUtil.decodeBase64(myKeys.signedPreKey.privateKey)
           });
           
           useSessionStore.getState().setSession(conversationId, session);
           console.log('[Crypto] Session initialized for Bob! Conversations are now secure.');
        }

        if (session) {
          const decryptedText = session.decrypt(content);
          console.log('[Crypto] Decrypted text:', decryptedText);
          
          const isImage = type === MessageType.IMAGE;
          const msg: DecryptedMessage = {
            id,
            conversationId,
            senderId,
            type,
            text: isImage ? '' : decryptedText,
            media: isImage ? { thumbnailUrl: decryptedText } as any : undefined,
            timestamp,
            status: MessageStatus.DELIVERED,
          };

          useMessagesStore.getState().addMessage(conversationId, msg);
          useConversationsStore.getState().updateLastMessage(conversationId, msg);
          if (useConversationsStore.getState().activeConversationId === conversationId) {
            useConversationsStore.getState().resetUnread(conversationId);
          } else {
            useConversationsStore.getState().incrementUnread(conversationId);
          }
        } else {
           // If session not found, store as encrypted or request keys
           console.warn('[App] No session for conversation', conversationId);
        }
      } catch (err) {
        console.error('[Crypto] Decryption failed:', err);
      }
    };

    const unsubConv = ws.on(WSEventType.CONVERSATION_CREATE, handleConvCreate);
    const unsubMsg = ws.on(WSEventType.MESSAGE_RECEIVED, handleMessage);

    // Initial action: upload keys if needed
    (async () => {
       const keysB64 = await window.pcm.keys.load();
       if (keysB64) {
          console.log('[Crypto] Key keys found locally. Uploading bundle to server...');
          const keys = JSON.parse(keysB64);
          if (!keys.signedPreKey) {
            console.warn('[Crypto] Missing signed pre-key in local storage. Skipping bundle upload.');
            return;
          }
          // Auto-upload pre-keys on login so others can start X3DH with us
          ws.uploadKeyBundle({
            signedPreKey: { 
               keyId: 1, 
               publicKey: keys.signedPreKey.publicKey, 
               signature: keys.signedPreKey.signature 
            },
            oneTimePreKeys: keys.oneTimePreKeys // In real app, rotating these
          });
          console.log('[Crypto] Key Bundle uploaded successfully! You are now reachable.');
       } else {
          console.warn('[Crypto] No local keys found. You might not be reachable for E2EE.');
       }
    })();

    return () => {
      unsubConv();
      unsubMsg();
    };
  }, [isAuthenticated]);

  // Sync call streams to store
  useEffect(() => {
    const s = getCallService();
    s.onRemoteStream((userId, stream) => {
      useCallStore.getState().setRemoteStream(userId, stream);
    });
    s.onCallEnd(() => {
      useCallStore.getState().setRemoteStreams({});
    });
  }, []);

  useEffect(() => {
    if (!activeConversationId) return;
    useConversationsStore.getState().resetUnread(activeConversationId);
  }, [activeConversationId]);

  return (
    <>
      <TitleBar />
      {!isAuthenticated ? (
        <AuthScreen />
      ) : (
        <div className="app-layout">
          <div className="app-sidebar-shell">
            <Sidebar />
            {showSettings && <SettingsPanel />}
          </div>
          <ChatView />
          <CallOverlay />
          <IncomingCallModal />
        </div>
      )}
    </>
  );
}
