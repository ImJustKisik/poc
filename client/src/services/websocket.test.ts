import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSEventType } from '@pcm/shared';
import { WebSocketService } from './websocket';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;

  readyState = MockWebSocket.OPEN;
  url: string;
  sentMessages: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sentMessages.push(payload);
  }

  close(code = 1000, reason = 'closed') {
    this.onclose?.({ code, reason });
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('websocket service', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('correlates request-response messages by id', async () => {
    const service = new WebSocketService('http://localhost:3001', 'token');
    await service.connect();

    const request = service.requestKeyBundle('user-2');
    const socket = MockWebSocket.instances[0];
    const sent = JSON.parse(socket.sentMessages[0]);

    socket.receive({
      event: WSEventType.KEY_BUNDLE_RESPONSE,
      id: sent.id,
      data: {
        targetUserId: 'user-2',
        identityKey: 'identity',
        signedPreKey: { keyId: 1, publicKey: 'spk', signature: 'sig' },
      },
      timestamp: Date.now(),
    });

    await expect(request).resolves.toMatchObject({ targetUserId: 'user-2' });
  });

  it('rejects pending requests when server sends a typed ws error', async () => {
    const service = new WebSocketService('http://localhost:3001', 'token');
    await service.connect();

    const request = service.requestKeyBundle('missing-user');
    const socket = MockWebSocket.instances[0];
    const sent = JSON.parse(socket.sentMessages[0]);

    socket.receive({
      event: WSEventType.ERROR,
      data: {
        code: 'NOT_FOUND',
        message: 'User not found',
        requestId: sent.id,
      },
      timestamp: Date.now(),
    });

    await expect(request).rejects.toThrow('User not found');
  });
});
