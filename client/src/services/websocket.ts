// ============================================================
// PCM Client — WebSocket Service
// ============================================================

import {
  WSEventType,
  type KeyBundleRequestPayload,
  type KeyBundleResponsePayload,
  type MessageSendPayload,
  type MessageStatus,
  type MessageStatusPayload,
  type WSMessage,
  type WsErrorPayload,
  WS_HEARTBEAT_INTERVAL,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
} from '@pcm/shared';
import { v4 as uuid } from 'uuid';
import { logDebug, logError } from './logger';
import { resolveServerUrl } from '../config';

type WSEventHandler = (data: any) => void;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private handlers = new Map<WSEventType, Set<WSEventHandler>>();
  private pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private reconnectDelay = WS_RECONNECT_BASE_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private messageQueue: WSMessage[] = [];

  constructor(url: string, token: string) {
    this.url = resolveServerUrl(url);
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        reject(new Error('Already connecting'));
        return;
      }

      this.isConnecting = true;
      const wsUrl = `${this.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectDelay = WS_RECONNECT_BASE_DELAY;
        this.startHeartbeat();
        this.flushQueue();
        logDebug('WS', 'Connected');
        resolve();
      };

      this.ws.onclose = (event) => {
        this.isConnecting = false;
        this.stopHeartbeat();
        logDebug('WS', `Disconnected: ${event.code} ${event.reason}`);

        if (this.shouldReconnect && event.code !== 4001) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        this.isConnecting = false;
        logError('WS', 'Error:', err);
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket connection failed'));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          logError('WS', 'Failed to parse message:', err);
        }
      };
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
  }

  updateToken(token: string) {
    this.token = token;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---- Event System ----

  on(event: WSEventType, handler: WSEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  off(event: WSEventType, handler: WSEventHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  // ---- Sending ----

  send(event: WSEventType, data: any, expectReply: boolean = false): Promise<any> | void {
    const msg: WSMessage = {
      event,
      data,
      id: uuid(),
      timestamp: Date.now(),
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.messageQueue.push(msg);
    }

    if (expectReply) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(msg.id!);
          reject(new Error('Request timed out'));
        }, 30_000);

        this.pendingRequests.set(msg.id!, { resolve, reject, timeout });
      });
    }
  }

  // ---- Convenience Methods ----

  sendMessage(data: MessageSendPayload) {
    this.send(WSEventType.MESSAGE_SEND, data);
  }

  sendMessageStatus(messageId: string, status: MessageStatus, targetUserId: string) {
    this.send(WSEventType.MESSAGE_STATUS, { messageId, status, targetUserId });
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    this.send(isTyping ? WSEventType.TYPING_START : WSEventType.TYPING_STOP, { conversationId });
  }

  requestKeyBundle(targetUserId: string): Promise<KeyBundleResponsePayload> {
    const payload: KeyBundleRequestPayload = { targetUserId };
    return this.send(WSEventType.KEY_BUNDLE_REQUEST, payload, true) as Promise<KeyBundleResponsePayload>;
  }

  uploadKeyBundle(data: {
    oneTimePreKeys?: { keyId: number; publicKey: string }[];
    signedPreKey?: { keyId: number; publicKey: string; signature: string };
  }) {
    this.send(WSEventType.KEY_BUNDLE_UPLOAD, data);
  }

  initiateCall(callId: string, conversationId: string, toUserId: string, type: string) {
    this.send(WSEventType.CALL_INITIATE, { callId, conversationId, toUserId, type });
  }

  sendCallSignal(event: WSEventType, data: any) {
    this.send(event, data);
  }

  // ---- Private ----

  private handleMessage(msg: WSMessage) {
    // Check for pending request reply
      if (msg.event === WSEventType.ERROR) {
        this.handleErrorMessage(msg);
        return;
      }

      if (msg.id && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timeout);
      pending.resolve(msg.data);
      this.pendingRequests.delete(msg.id);
      return;
    }

    // Handle pong
    if (msg.event === WSEventType.PONG) return;

    // Handle ping
    if (msg.event === WSEventType.PING) {
      this.send(WSEventType.PONG, {});
      return;
    }

    // Dispatch to handlers
    const eventHandlers = this.handlers.get(msg.event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(msg.data);
        } catch (err) {
          logError('WS', `Handler error for ${msg.event}:`, err);
        }
      }
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send(WSEventType.PING, {});
      }
    }, WS_HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    logDebug('WS', `Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(err => {
        logError('WS', 'Reconnect failed:', err);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, WS_RECONNECT_MAX_DELAY);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  private flushQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    }
  }

  private handleErrorMessage(msg: WSMessage) {
    const payload = msg.data as WsErrorPayload;
    const requestId = payload?.requestId || msg.id;
    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      clearTimeout(pending.timeout);
      pending.reject(new Error(payload.message));
      this.pendingRequests.delete(requestId);
      return;
    }

    const eventHandlers = this.handlers.get(WSEventType.ERROR);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        handler(payload);
      }
      return;
    }

    logError('WS', payload?.message || 'Unknown WebSocket error');
  }
}

// Singleton instance (created on login)
let wsService: WebSocketService | null = null;

export function createWSService(serverUrl: string, token: string): WebSocketService {
  if (wsService) {
    wsService.disconnect();
  }
  wsService = new WebSocketService(serverUrl, token);
  return wsService;
}

export function getWSService(): WebSocketService | null {
  return wsService;
}
