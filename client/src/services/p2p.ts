// ============================================================
// PCM Client — P2P Service (WebRTC DataChannel)
// ============================================================

import { STUN_SERVERS, WSEventType } from '@pcm/shared';
import { getWSService } from './websocket';

export interface PeerConnection {
  userId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  isInitiator: boolean;
}

type MessageHandler = (userId: string, data: any) => void;

export class P2PService {
  private peers = new Map<string, PeerConnection>();
  private messageHandlers: MessageHandler[] = [];

  constructor() {
    this.setupWSListeners();
  }

  private setupWSListeners() {
    const ws = getWSService();
    if (!ws) return;

    // Reuse call signaling for P2P data channels
    ws.on(WSEventType.CALL_SDP_OFFER, (data) => {
      if (data.isP2P) this.handleP2POffer(data);
    });
    ws.on(WSEventType.CALL_SDP_ANSWER, (data) => {
      if (data.isP2P) this.handleP2PAnswer(data);
    });
    ws.on(WSEventType.CALL_ICE_CANDIDATE, (data) => {
      if (data.isP2P) this.handleP2PICE(data);
    });
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
  }

  async connectToPeer(userId: string): Promise<void> {
    const ws = getWSService();
    if (!ws) throw new Error('WebSocket not connected');

    const pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS.map(url => ({ urls: url })),
    });

    const dataChannel = pc.createDataChannel('pcm-data', { ordered: true });
    this.setupDataChannel(dataChannel, userId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.sendCallSignal(WSEventType.CALL_ICE_CANDIDATE, {
          toUserId: userId,
          candidate: event.candidate.toJSON(),
          isP2P: true,
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.sendCallSignal(WSEventType.CALL_SDP_OFFER, {
      toUserId: userId,
      sdp: offer,
      isP2P: true,
    });

    this.peers.set(userId, { userId, connection: pc, dataChannel, isInitiator: true });
  }

  sendToPeer(userId: string, data: any): boolean {
    const peer = this.peers.get(userId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return false;

    peer.dataChannel.send(JSON.stringify(data));
    return true;
  }

  sendFile(userId: string, fileData: ArrayBuffer, metadata: { name: string; type: string; size: number }): boolean {
    const peer = this.peers.get(userId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== 'open') return false;

    // Send metadata first
    peer.dataChannel.send(JSON.stringify({ ...metadata, type: 'file-meta' }));

    // Send file in chunks (64KB)
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < fileData.byteLength; offset += chunkSize) {
      const chunk = fileData.slice(offset, Math.min(offset + chunkSize, fileData.byteLength));
      peer.dataChannel.send(chunk);
    }

    // Send end marker
    peer.dataChannel.send(JSON.stringify({ type: 'file-end' }));
    return true;
  }

  isConnected(userId: string): boolean {
    const peer = this.peers.get(userId);
    return peer?.dataChannel?.readyState === 'open';
  }

  disconnectPeer(userId: string) {
    const peer = this.peers.get(userId);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(userId);
    }
  }

  disconnectAll() {
    for (const [userId] of this.peers) {
      this.disconnectPeer(userId);
    }
  }

  // ---- Private ----

  private setupDataChannel(channel: RTCDataChannel, userId: string) {
    channel.onopen = () => {
      console.log(`[P2P] DataChannel open with ${userId}`);
    };

    channel.onclose = () => {
      console.log(`[P2P] DataChannel closed with ${userId}`);
      this.peers.delete(userId);
    };

    channel.onmessage = (event) => {
      try {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          this.messageHandlers.forEach(h => h(userId, data));
        } else {
          // Binary data (file chunk)
          this.messageHandlers.forEach(h => h(userId, { type: 'file-chunk', data: event.data }));
        }
      } catch (err) {
        console.error('[P2P] Message parse error:', err);
      }
    };
  }

  private async handleP2POffer(data: { fromUserId: string; sdp: RTCSessionDescriptionInit }) {
    const ws = getWSService();
    if (!ws) return;

    const pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS.map(url => ({ urls: url })),
    });

    pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel, data.fromUserId);
      const peer = this.peers.get(data.fromUserId);
      if (peer) peer.dataChannel = event.channel;
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.sendCallSignal(WSEventType.CALL_ICE_CANDIDATE, {
          toUserId: data.fromUserId,
          candidate: event.candidate.toJSON(),
          isP2P: true,
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.sendCallSignal(WSEventType.CALL_SDP_ANSWER, {
      toUserId: data.fromUserId,
      sdp: answer,
      isP2P: true,
    });

    this.peers.set(data.fromUserId, { userId: data.fromUserId, connection: pc, dataChannel: null, isInitiator: false });
  }

  private async handleP2PAnswer(data: { fromUserId: string; sdp: RTCSessionDescriptionInit }) {
    const peer = this.peers.get(data.fromUserId);
    if (!peer) return;
    await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }

  private async handleP2PICE(data: { fromUserId: string; candidate: RTCIceCandidateInit }) {
    const peer = this.peers.get(data.fromUserId);
    if (!peer) return;
    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('[P2P] Failed to add ICE candidate:', err);
    }
  }
}

// Singleton
let p2pService: P2PService | null = null;

export function createP2PService(): P2PService {
  p2pService = new P2PService();
  return p2pService;
}

export function getP2PService(): P2PService | null {
  return p2pService;
}
