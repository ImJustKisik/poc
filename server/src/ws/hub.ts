// ============================================================
// PCM Server — WebSocket Hub
// ============================================================

import type { WebSocket } from 'ws';
import {
  MessageStatus,
  MessageType,
  WSEventType,
  type CallAcceptPayload,
  type CallEndPayload,
  type CallInitiatePayload,
  type EncryptedPayload,
  type KeyBundleRequestPayload,
  type KeyBundleResponsePayload,
  type KeyBundleUploadPayload,
  type MessageReceivedPayload,
  type MessageSendPayload,
  type MessageStatusPayload,
  type SfuConnectWebRtcTransportRequest,
  type SfuConsumeRequest,
  type SfuConsumerOptions,
  type SfuCreateWebRtcTransportRequest,
  type SfuGetRouterRtpCapabilitiesRequest,
  type SfuNewProducerPayload,
  type SfuProduceRequest,
  type SfuRestartIceRequest,
  type SfuRestartIceResponse,
  type SfuResumeConsumerRequest,
  type SfuTransportOptions,
  type WSMessage,
  type WsErrorPayload,
} from '@pcm/shared';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { sfuService } from './sfu.js';


interface ConnectedClient {
  socket: WebSocket;
  userId: string;
  publicKey: string;
  lastPing: number;
}

class WebSocketHub {
  private clients = new Map<string, ConnectedClient>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  start() {
    // Heartbeat: check every 30s, close stale connections
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [userId, client] of this.clients) {
        if (now - client.lastPing > 60_000) {
          client.socket.close(4001, 'Heartbeat timeout');
          this.clients.delete(userId);
        } else {
          this.send(client.socket, { event: WSEventType.PING, data: {}, timestamp: now });
        }
      }
    }, 30_000);
  }

  stop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    for (const [, client] of this.clients) {
      client.socket.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }

  addClient(userId: string, publicKey: string, socket: WebSocket) {
    // Close existing connection if any
    const existing = this.clients.get(userId);
    if (existing) {
      existing.socket.close(4000, 'New connection established');
    }

    const client: ConnectedClient = { socket, userId, publicKey, lastPing: Date.now() };
    this.clients.set(userId, client);

    socket.on('message', (data) => this.handleMessage(userId, data.toString()));
    socket.on('close', () => this.removeClient(userId, socket));
    socket.on('error', () => this.removeClient(userId, socket));

    // Broadcast online presence
    this.broadcastPresence(userId, 'online');

    // Deliver queued offline messages
    this.deliverQueuedMessages(userId);
  }

  removeClient(userId: string, socket?: WebSocket) {
    const current = this.clients.get(userId);
    if (!current) return;
    if (socket && current.socket !== socket) return;

    this.clients.delete(userId);
    sfuService.cleanupUser(userId);
    this.broadcastPresence(userId, 'offline');
  }

  isOnline(userId: string): boolean {
    return this.clients.has(userId);
  }

  getOnlineUsers(): string[] {
    return Array.from(this.clients.keys());
  }

  sendToUser(userId: string, msg: WSMessage) {
    const client = this.clients.get(userId);
    if (client) {
      this.send(client.socket, msg);
    }
  }

  private async handleMessage(senderId: string, rawData: string) {
    try {
      const msg: WSMessage = JSON.parse(rawData);
      const client = this.clients.get(senderId);
      if (!client) return;

      if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string' || typeof msg.timestamp !== 'number') {
        this.sendError(client.socket, 'INVALID_MESSAGE', 'Invalid WebSocket payload');
        return;
      }

      client.lastPing = Date.now();

      switch (msg.event) {
        case WSEventType.PONG:
          break;

        case WSEventType.MESSAGE_SEND:
          await this.handleMessageSend(senderId, msg);
          break;

        case WSEventType.MESSAGE_STATUS:
          await this.handleMessageStatus(senderId, msg);
          break;

        case WSEventType.MESSAGE_EDIT:
        case WSEventType.MESSAGE_DELETE:
        case WSEventType.MESSAGE_REACTION:
          await this.relayToConversation(senderId, msg);
          break;

        case WSEventType.TYPING_START:
        case WSEventType.TYPING_STOP:
          await this.relayToConversation(senderId, msg);
          break;

        case WSEventType.KEY_BUNDLE_REQUEST:
          await this.handleKeyBundleRequest(senderId, msg);
          break;

        case WSEventType.KEY_BUNDLE_UPLOAD:
          await this.handleKeyBundleUpload(senderId, msg);
          break;

        case WSEventType.CALL_INITIATE:
        case WSEventType.CALL_ACCEPT:
        case WSEventType.CALL_REJECT:
        case WSEventType.CALL_END:
        case WSEventType.CALL_ICE_CANDIDATE:
        case WSEventType.CALL_SDP_OFFER:
        case WSEventType.CALL_SDP_ANSWER:
          await this.relayCallSignal(senderId, msg);
          break;

        case WSEventType.PRESENCE_ONLINE:
        case WSEventType.PRESENCE_OFFLINE:
          this.broadcastPresence(senderId, (msg.data as { status: string }).status);
          break;


        // ---- SFU ----
        case WSEventType.SFU_GET_ROUTER_RTP_CAPABILITIES:
          await this.handleSfuGetRouterRtpCapabilities(senderId, msg);
          break;
        case WSEventType.SFU_CREATE_WEBRTC_TRANSPORT:
          await this.handleSfuCreateWebRtcTransport(senderId, msg);
          break;
        case WSEventType.SFU_CONNECT_WEBRTC_TRANSPORT:
          await this.handleSfuConnectWebRtcTransport(senderId, msg);
          break;
        case WSEventType.SFU_PRODUCE:
          await this.handleSfuProduce(senderId, msg);
          break;
        case WSEventType.SFU_CONSUME:
          await this.handleSfuConsume(senderId, msg);
          break;
        case WSEventType.SFU_RESUME_CONSUMER:
          await this.handleSfuResumeConsumer(senderId, msg);
          break;
        case WSEventType.SFU_RESTART_ICE:
          await this.handleSfuRestartIce(senderId, msg);
          break;


        default:
          this.sendError(client.socket, 'UNKNOWN_EVENT', 'Unknown event type', msg.id);
      }
    } catch (err) {
      const client = this.clients.get(senderId);
      if (client) {
        this.sendError(client.socket, 'INVALID_JSON', 'Failed to parse WebSocket message');
      }
    }
  }

  private async isConversationMember(conversationId: string, userId: string): Promise<boolean> {
    const membership = await db.select({ id: schema.conversationMembers.id }).from(schema.conversationMembers)
      .where(and(
        eq(schema.conversationMembers.conversationId, conversationId),
        eq(schema.conversationMembers.userId, userId),
      ))
      .limit(1);

    return membership.length > 0;
  }

  private async handleMessageSend(senderId: string, msg: WSMessage) {
    const data = msg.data as MessageSendPayload;
    const client = this.clients.get(senderId);
    if (!client) return;

    if (!this.isMessageSendPayload(data)) {
      this.sendError(client.socket, 'INVALID_PAYLOAD', 'Invalid message send payload', msg.id);
      return;
    }

    if (!await this.isConversationMember(data.conversationId, senderId)) {
      this.sendError(client.socket, 'FORBIDDEN', 'Not a member of this conversation', msg.id);
      return;
    }

    // Relay to online recipients, queue for offline ones
    for (const recipientId of data.recipientIds) {
      const recipientClient = this.clients.get(recipientId);
      const payload = data.encryptedPayloads[recipientId];
      if (!payload) continue;

      const outMsg: WSMessage<MessageReceivedPayload> = {
        event: WSEventType.MESSAGE_RECEIVED,
        data: {
          id: data.id,
          conversationId: data.conversationId,
          senderId,
          content: payload,
          type: data.messageType,
          timestamp: data.timestamp,
        },
        id: msg.id,
        timestamp: Date.now(),
      };

      if (recipientClient) {
        this.send(recipientClient.socket, outMsg);

        // Send delivery ack back to sender
        const senderClient = this.clients.get(senderId);
        if (senderClient) {
          this.send(senderClient.socket, {
            event: WSEventType.MESSAGE_STATUS,
            data: { messageId: data.id, status: MessageStatus.DELIVERED, recipientId },
            timestamp: Date.now(),
          });
        }
      } else {
        // Queue for offline delivery
        await db.insert(schema.messageQueue).values({
          id: `${data.id}_${recipientId}`,
          recipientId,
          senderId,
          conversationId: data.conversationId,
          encryptedPayload: JSON.stringify(payload),
          messageType: data.messageType,
          timestamp: data.timestamp,
        });
      }
    }

    // Send ack to sender
    const senderClient = this.clients.get(senderId);
    if (senderClient) {
      this.send(senderClient.socket, {
        event: WSEventType.MESSAGE_ACK,
        data: { messageId: data.id, status: MessageStatus.SENT },
        id: msg.id,
        timestamp: Date.now(),
      });
    }
  }

  private async handleMessageStatus(senderId: string, msg: WSMessage) {
    const data = msg.data as MessageStatusPayload;
    const client = this.clients.get(senderId);
    if (!client) return;

    if (!data?.messageId || !data?.status || !data?.targetUserId) {
      this.sendError(client.socket, 'INVALID_PAYLOAD', 'Invalid message status payload', msg.id);
      return;
    }

    const targetClient = this.clients.get(data.targetUserId);
    if (targetClient) {
      this.send(targetClient.socket, {
        event: WSEventType.MESSAGE_STATUS,
        data: { messageId: data.messageId, status: data.status, recipientId: senderId },
        timestamp: Date.now(),
      });
    }
  }

  private async handleKeyBundleRequest(senderId: string, msg: WSMessage) {
    const { targetUserId } = msg.data as KeyBundleRequestPayload;
    const senderClient = this.clients.get(senderId);
    if (!senderClient) return;

    if (!targetUserId) {
      this.sendError(senderClient.socket, 'INVALID_PAYLOAD', 'targetUserId is required', msg.id);
      return;
    }

    // Fetch key bundle from DB
    const targetUsers = await db.select().from(schema.users).where(eq(schema.users.id, targetUserId));
    if (targetUsers.length === 0) {
      this.sendError(senderClient.socket, 'NOT_FOUND', 'User not found', msg.id);
      return;
    }

    const signedKeys = await db.select().from(schema.signedPreKeys)
      .where(eq(schema.signedPreKeys.userId, targetUserId))
      .limit(1);
    if (signedKeys.length === 0) {
      this.sendError(senderClient.socket, 'NOT_FOUND', 'User has no signed pre-key', msg.id);
      return;
    }

    // Pop one one-time pre-key (mark as used)
    const otpKeys = await db.select().from(schema.oneTimePreKeys)
      .where(and(
        eq(schema.oneTimePreKeys.userId, targetUserId),
        eq(schema.oneTimePreKeys.used, false),
      ))
      .limit(1);

    if (otpKeys.length > 0) {
      await db.update(schema.oneTimePreKeys)
        .set({ used: true })
        .where(eq(schema.oneTimePreKeys.id, otpKeys[0].id));
    }

    const response: KeyBundleResponsePayload = {
      targetUserId,
      identityKey: targetUsers[0].publicKey,
      signedPreKey: {
        keyId: signedKeys[0].keyId,
        publicKey: signedKeys[0].publicKey,
        signature: signedKeys[0].signature,
      },
      oneTimePreKey: otpKeys[0] ? {
        keyId: otpKeys[0].keyId,
        publicKey: otpKeys[0].publicKey,
      } : undefined,
    };

    this.send(senderClient.socket, {
        event: WSEventType.KEY_BUNDLE_RESPONSE,
        data: response,
        id: msg.id,
        timestamp: Date.now(),
      });
  }

  private async handleKeyBundleUpload(senderId: string, msg: WSMessage) {
    const data = msg.data as KeyBundleUploadPayload;
    const client = this.clients.get(senderId);
    if (!client) return;

    if (!data?.signedPreKey && (!data?.oneTimePreKeys || data.oneTimePreKeys.length === 0)) {
      this.sendError(client.socket, 'INVALID_PAYLOAD', 'Key bundle payload is empty', msg.id);
      return;
    }

    if (data.oneTimePreKeys && data.oneTimePreKeys.length > 0) {
      await db.insert(schema.oneTimePreKeys).values(
        data.oneTimePreKeys.map((k: { keyId: number; publicKey: string }) => ({
          userId: senderId,
          keyId: k.keyId,
          publicKey: k.publicKey,
        }))
      );
    }

    if (data.signedPreKey) {
      await db.delete(schema.signedPreKeys).where(eq(schema.signedPreKeys.userId, senderId));
      await db.insert(schema.signedPreKeys).values({
        userId: senderId,
        keyId: data.signedPreKey.keyId,
        publicKey: data.signedPreKey.publicKey,
        signature: data.signedPreKey.signature,
        createdAt: Date.now(),
      });
    }
  }

  private async relayToConversation(senderId: string, msg: WSMessage) {
    const { conversationId } = msg.data as { conversationId: string };
    const senderClient = this.clients.get(senderId);
    if (!senderClient) return;

    if (!conversationId) {
      this.sendError(senderClient.socket, 'INVALID_PAYLOAD', 'conversationId is required', msg.id);
      return;
    }

    if (!await this.isConversationMember(conversationId, senderId)) {
      this.sendError(senderClient.socket, 'FORBIDDEN', 'Not a member of this conversation', msg.id);
      return;
    }

    // Get conversation members
    const members = await db.select().from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.conversationId, conversationId));

    for (const member of members) {
      if (member.userId === senderId) continue;
      const client = this.clients.get(member.userId);
      if (client) {
        this.send(client.socket, { ...msg, timestamp: Date.now() });
      }
    }
  }

  private async relayCallSignal(senderId: string, msg: WSMessage) {
    const data = msg.data as CallInitiatePayload | CallAcceptPayload | CallEndPayload;
    const senderClient = this.clients.get(senderId);
    if (!senderClient) return;

    if (data.conversationId && !await this.isConversationMember(data.conversationId, senderId)) {
      this.sendError(senderClient.socket, 'FORBIDDEN', 'Not a member of this conversation', msg.id);
      return;
    }

    if (data.toUserId) {
      // 1-on-1 call signaling
      const targetClient = this.clients.get(data.toUserId);
      if (targetClient) {
        this.send(targetClient.socket, {
          ...msg,
          data: { ...data, fromUserId: senderId },
          timestamp: Date.now(),
        });
      }

      // If this is a CALL_ACCEPT, also inform the accepting party about existing producers (if any)
      if (msg.event === WSEventType.CALL_ACCEPT && data.conversationId) {
        const producers = sfuService.getProducers(data.conversationId, senderId);
        for (const p of producers) {
          const recipient = this.clients.get(senderId);
          if (!recipient) continue;
          this.send(recipient.socket, {
            event: WSEventType.SFU_NEW_PRODUCER,
            data: p,
            timestamp: Date.now(),
          });
        }
      }
    } else if (data.participants) {
      // Group call signaling
      for (const participantId of data.participants) {
        if (participantId === senderId) continue;
        const client = this.clients.get(participantId);
        if (client) {
          this.send(client.socket, {
            ...msg,
            data: { ...data, fromUserId: senderId },
            timestamp: Date.now(),
          });
        }
      }

      // If this is a CALL_ACCEPT (joining group call), also inform the joiner of existing producers
      if (msg.event === WSEventType.CALL_ACCEPT && data.conversationId) {
        const producers = sfuService.getProducers(data.conversationId, senderId);
        for (const p of producers) {
          const recipient = this.clients.get(senderId);
          if (!recipient) continue;
          this.send(recipient.socket, {
            event: WSEventType.SFU_NEW_PRODUCER,
            data: p,
            timestamp: Date.now(),
          });
        }
      }
    }
    if (msg.event === WSEventType.CALL_END && data.conversationId) {
      await sfuService.leaveConversation(senderId, data.conversationId);
    }
  }

  private async deliverQueuedMessages(userId: string) {
    const client = this.clients.get(userId);
    if (!client) return;

    const queued = await db.select().from(schema.messageQueue)
      .where(and(
        eq(schema.messageQueue.recipientId, userId),
        eq(schema.messageQueue.delivered, false),
      ));

    for (const qm of queued) {
      this.send(client.socket, {
        event: WSEventType.MESSAGE_RECEIVED,
        data: {
          id: qm.id.replace(`_${userId}`, ''),
          conversationId: qm.conversationId,
          senderId: qm.senderId,
          content: JSON.parse(qm.encryptedPayload),
          type: qm.messageType,
          timestamp: qm.timestamp,
        },
        timestamp: Date.now(),
      });
    }

    // Mark as delivered
    if (queued.length > 0) {
      for (const qm of queued) {
        await db.update(schema.messageQueue)
          .set({ delivered: true })
          .where(eq(schema.messageQueue.id, qm.id));
      }
    }
  }

  private broadcastPresence(userId: string, status: string) {
    const msg: WSMessage = {
      event: status === 'offline' ? WSEventType.PRESENCE_OFFLINE : WSEventType.PRESENCE_ONLINE,
      data: { userId, status, lastSeen: Date.now() },
      timestamp: Date.now(),
    };

    for (const [id, client] of this.clients) {
      if (id !== userId) {
        this.send(client.socket, msg);
      }
    }
  }

  private async handleSfuGetRouterRtpCapabilities(senderId: string, msg: WSMessage) {
    const { conversationId } = msg.data as SfuGetRouterRtpCapabilitiesRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      if (!conversationId) {
        throw new Error('conversationId is required');
      }
      if (!await this.isConversationMember(conversationId, senderId)) {
        throw new Error('Not a member of this conversation');
      }
      const caps = await sfuService.getRouterRtpCapabilities(conversationId);
      this.send(client.socket, { event: msg.event, data: caps, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_ROUTER_CAPS_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuCreateWebRtcTransport(senderId: string, msg: WSMessage) {
    const { conversationId } = msg.data as SfuCreateWebRtcTransportRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      if (!conversationId) {
        throw new Error('conversationId is required');
      }
      if (!await this.isConversationMember(conversationId, senderId)) {
        throw new Error('Not a member of this conversation');
      }
      const transport = await sfuService.createTransport(conversationId, senderId);
      const data: SfuTransportOptions = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates.map((candidate) => ({
          foundation: candidate.foundation,
          priority: candidate.priority,
          ip: candidate.ip,
          protocol: candidate.protocol,
          port: candidate.port,
          type: candidate.type,
          tcpType: candidate.tcpType,
        })),
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters || undefined,
      };
      this.send(client.socket, { event: msg.event, data, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_CREATE_TRANSPORT_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuConnectWebRtcTransport(senderId: string, msg: WSMessage) {
    const { transportId, dtlsParameters } = msg.data as SfuConnectWebRtcTransportRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      await sfuService.connectTransport(transportId, senderId, dtlsParameters);
      this.send(client.socket, { event: msg.event, data: { success: true }, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_CONNECT_TRANSPORT_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuProduce(senderId: string, msg: WSMessage) {
    const { transportId, kind, rtpParameters } = msg.data as SfuProduceRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      const producer = await sfuService.produce(transportId, senderId, kind, rtpParameters);
      this.send(client.socket, { event: msg.event, data: { id: producer.id }, id: msg.id, timestamp: Date.now() });

      // Notify others in the conversation
      const { conversationId } = producer as typeof producer & { conversationId: string };
      const members = await db.select().from(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, conversationId));
      
      for (const m of members) {
        if (m.userId === senderId) continue;
        const recipient = this.clients.get(m.userId);
        if (recipient) {
          const payload: SfuNewProducerPayload = { producerId: producer.id, userId: senderId, kind };
          this.send(recipient.socket, {
            event: WSEventType.SFU_NEW_PRODUCER,
            data: payload,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_PRODUCE_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuConsume(senderId: string, msg: WSMessage) {
    const { transportId, producerId, rtpCapabilities } = msg.data as SfuConsumeRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      const consumer = await sfuService.consume(transportId, senderId, producerId, rtpCapabilities as never);
      const data: SfuConsumerOptions = {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind as 'audio' | 'video',
        rtpParameters: consumer.rtpParameters as never,
        type: consumer.type,
      };
      this.send(client.socket, { event: msg.event, data, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_CONSUME_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuResumeConsumer(senderId: string, msg: WSMessage) {
    const { consumerId } = msg.data as SfuResumeConsumerRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      await sfuService.resumeConsumer(consumerId, senderId);
      this.send(client.socket, { event: msg.event, data: { success: true }, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_RESUME_CONSUMER_FAILED', err.message, msg.id);
    }
  }

  private async handleSfuRestartIce(senderId: string, msg: WSMessage) {
    const { transportId } = msg.data as SfuRestartIceRequest;
    const client = this.clients.get(senderId);
    if (!client) return;

    try {
      const iceParameters = await sfuService.restartIce(transportId, senderId);
      const data: SfuRestartIceResponse = { transportId, iceParameters };
      this.send(client.socket, { event: msg.event, data, id: msg.id, timestamp: Date.now() });
    } catch (err: any) {
      this.sendError(client.socket, 'SFU_RESTART_ICE_FAILED', err.message, msg.id);
    }
  }

  private send(socket: WebSocket, msg: WSMessage) {
    if (socket.readyState === 1) { // OPEN
      socket.send(JSON.stringify(msg));
    }
  }

  private sendError(socket: WebSocket, code: string, message: string, requestId?: string) {
    const payload: WsErrorPayload = { code, message, requestId };
    this.send(socket, {
      event: WSEventType.ERROR,
      data: payload,
      timestamp: Date.now(),
    });
  }

  private isMessageSendPayload(data: MessageSendPayload): data is MessageSendPayload {
    if (!data || typeof data !== 'object') return false;
    if (!data.id || !data.conversationId || typeof data.timestamp !== 'number') return false;
    if (!Array.isArray(data.recipientIds) || data.recipientIds.length === 0) return false;
    if (!data.encryptedPayloads || typeof data.encryptedPayloads !== 'object') return false;
    return data.recipientIds.every((recipientId: string) => this.isEncryptedPayload(data.encryptedPayloads[recipientId]));
  }

  private isEncryptedPayload(payload: EncryptedPayload | undefined): payload is EncryptedPayload {
    return !!payload && typeof payload.ciphertext === 'string' && (typeof payload.iv === 'string' || typeof payload.nonce === 'string');
  }
}

export const wsHub = new WebSocketHub();
