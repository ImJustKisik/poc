// ============================================================
// PCM Client — WebRTC Call Service
// ============================================================

import { CallType, CallStatus, WSEventType } from '@pcm/shared';
import type {
  CallSession,
  SfuConnectWebRtcTransportRequest,
  SfuConsumerOptions,
  SfuProduceRequest,
  SfuRestartIceResponse,
  SfuTransportOptions,
} from '@pcm/shared';
import { getWSService } from './websocket';
import { useCallStore } from '../stores';
import { v4 as uuid } from 'uuid';
import { Device, types } from 'mediasoup-client';
import { logDebug, logError } from './logger';
// Using types from mediasoup-client/lib/types if needed, but 'types' export is cleaner
type Transport = types.Transport;
type Producer = types.Producer;
type Consumer = types.Consumer;


export class CallService {
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producers = new Map<string, Producer>(); // kind -> Producer
  private consumers = new Map<string, Consumer>(); // producerId -> Consumer
  
  private localStream: MediaStream | null = null;
  private remoteStreams = new Map<string, MediaStream>(); // userId -> MediaStream
  private callId: string | null = null;
  private conversationId: string | null = null;

  private onRemoteStreamCallback: ((userId: string, stream: MediaStream) => void) | null = null;
  private onCallEndCallback: (() => void) | null = null;
  private wsUnsubscribers: Array<() => void> = [];


  constructor() {
    this.bindToCurrentWS();
  }

  bindToCurrentWS() {
    this.wsUnsubscribers.forEach(unsub => unsub());
    this.wsUnsubscribers = [];

    const ws = getWSService();
    if (!ws) return;

    this.wsUnsubscribers.push(ws.on(WSEventType.CALL_INITIATE, (data) => this.handleIncomingCall(data)));
    this.wsUnsubscribers.push(ws.on(WSEventType.CALL_ACCEPT, (data) => this.handleCallAccepted(data)));
    this.wsUnsubscribers.push(ws.on(WSEventType.CALL_REJECT, (data) => this.handleCallRejected(data)));
    this.wsUnsubscribers.push(ws.on(WSEventType.CALL_END, (data) => this.handleCallEnded(data)));
    this.wsUnsubscribers.push(ws.on(WSEventType.SFU_NEW_PRODUCER, (data) => this.handleNewProducer(data)));
  }

  onRemoteStream(callback: (userId: string, stream: MediaStream) => void) {
    this.onRemoteStreamCallback = callback;
  }

  onCallEnd(callback: () => void) {
    this.onCallEndCallback = callback;
  }

  // ---- Initiate Call ----

  async initiateCall(conversationId: string, toUserId: string, type: CallType): Promise<string> {
    this.callId = uuid();
    this.conversationId = conversationId;
    const ws = getWSService();
    if (!ws) throw new Error('WebSocket not connected');

    // SFU: Initialize Device
    await this.initSfu(conversationId);

    // Get local media
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === CallType.VIDEO,
    });

    // Create Send Transport
    await this.createSendTransport();

    // Produce local tracks
    for (const track of this.localStream.getTracks()) {
      await this.produce(track);
    }

    ws.sendCallSignal(WSEventType.CALL_INITIATE, {
      callId: this.callId,
      conversationId,
      toUserId,
      type,
    });

    // Update store
    const callSession: CallSession = {
      callId: this.callId,
      type,
      initiatorId: '', // Will be set by store
      participants: [toUserId],
      conversationId,
      status: CallStatus.RINGING,
      startedAt: Date.now(),
    };

    useCallStore.getState().setActiveCall(callSession);
    return this.callId;
  }

  // ---- Accept Call ----

  async acceptCall(callId: string, fromUserId: string, type: CallType) {
    this.callId = callId;
    const ws = getWSService();
    if (!ws) throw new Error('WebSocket not connected');

    const activeCall = useCallStore.getState().activeCall || useCallStore.getState().incomingCall;
    if (!activeCall) return;
    this.conversationId = activeCall.conversationId;

    // SFU: Initialize Device
    await this.initSfu(this.conversationId!);

    // Get local media
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === CallType.VIDEO,
    });

    // Create Transports
    await this.createSendTransport();
    await this.createRecvTransport();

    // Produce local tracks
    for (const track of this.localStream.getTracks()) {
      await this.produce(track);
    }

    ws.sendCallSignal(WSEventType.CALL_ACCEPT, {
      callId,
      conversationId: this.conversationId,
      toUserId: fromUserId,
    });

    useCallStore.getState().setIncomingCall(null);
    useCallStore.getState().setActiveCall({ ...activeCall, status: CallStatus.ACTIVE });
  }

  rejectCall(callId: string, fromUserId: string) {
    const ws = getWSService();
    if (!ws) return;

    ws.sendCallSignal(WSEventType.CALL_REJECT, {
      callId,
      toUserId: fromUserId,
    });

    useCallStore.getState().setIncomingCall(null);
  }

  // ---- End Call ----

  endCall() {
    const ws = getWSService();
    if (ws && this.callId) {
      const participants = useCallStore.getState().activeCall?.participants || [];
      ws.sendCallSignal(WSEventType.CALL_END, {
        callId: this.callId,
        conversationId: this.conversationId,
        participants,
      });
    }
    this.cleanup();
  }

  // ---- Toggle Audio/Video ----

  toggleMute(): boolean {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      return !audioTrack.enabled;
    }
    return false;
  }

  toggleVideo(): boolean {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      return !videoTrack.enabled;
    }
    return false;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStreams(): Map<string, MediaStream> {
    return this.remoteStreams;
  }


  // ---- Private: Mediasoup SFU ----

  private async initSfu(conversationId: string) {
    if (this.device) return;

    const ws = getWSService();
    if (!ws) return;

    const routerRtpCapabilities = await ws.send(WSEventType.SFU_GET_ROUTER_RTP_CAPABILITIES, { conversationId }, true);

    this.device = new Device();
    await this.device.load({ routerRtpCapabilities });
  }


  private async createSendTransport() {
    if (!this.device || !this.conversationId) return;
    const ws = getWSService();
    if (!ws) return;

    const options = await ws.send(
      WSEventType.SFU_CREATE_WEBRTC_TRANSPORT,
      { conversationId: this.conversationId },
      true
    ) as SfuTransportOptions;

    this.sendTransport = this.device.createSendTransport(options as types.TransportOptions);
    this.attachTransportLifecycle(this.sendTransport);

    this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const payload: SfuConnectWebRtcTransportRequest = { transportId: this.sendTransport!.id, dtlsParameters };
        await ws.send(WSEventType.SFU_CONNECT_WEBRTC_TRANSPORT, payload, true);
        callback();
      } catch (err: any) {
        errback(err);
      }
    });

    this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const payload: SfuProduceRequest = {
          transportId: this.sendTransport!.id,
          kind: kind as 'audio' | 'video',
          rtpParameters: rtpParameters as SfuProduceRequest['rtpParameters'],
        };
        const { id } = await ws.send(WSEventType.SFU_PRODUCE, payload, true);
        callback({ id });
      } catch (err: any) {
        errback(err);
      }
    });
  }

  private async createRecvTransport() {
    if (!this.device || !this.conversationId) return;
    const ws = getWSService();
    if (!ws) return;

    const options = await ws.send(
      WSEventType.SFU_CREATE_WEBRTC_TRANSPORT,
      { conversationId: this.conversationId },
      true
    ) as SfuTransportOptions;

    this.recvTransport = this.device.createRecvTransport(options as types.TransportOptions);
    this.attachTransportLifecycle(this.recvTransport);

    this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const payload: SfuConnectWebRtcTransportRequest = { transportId: this.recvTransport!.id, dtlsParameters };
        await ws.send(WSEventType.SFU_CONNECT_WEBRTC_TRANSPORT, payload, true);
        callback();
      } catch (err: any) {
        errback(err);
      }
    });
  }

  private async produce(track: MediaStreamTrack) {
    if (!this.sendTransport) return;
    const producer = await this.sendTransport.produce({ track });
    this.producers.set(track.kind, producer);
  }

  private async consume(producerId: string, userId: string) {
    if (!this.recvTransport || !this.device) return;
    const ws = getWSService();
    if (!ws) return;

    const options = await ws.send(WSEventType.SFU_CONSUME, {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    }, true) as SfuConsumerOptions;

    const consumer = await this.recvTransport.consume(options as types.ConsumerOptions);
    this.consumers.set(producerId, consumer);

    const stream = new MediaStream([consumer.track]);
    this.remoteStreams.set(userId, stream);
    this.onRemoteStreamCallback?.(userId, stream);

    // Resume consumer on server
    await ws.send(WSEventType.SFU_RESUME_CONSUMER, { consumerId: consumer.id }, true);
  }

  // ---- Private: Signal Handlers ----

  private handleIncomingCall(data: { callId: string; fromUserId: string; conversationId: string; type: CallType }) {
    const callSession: CallSession = {
      callId: data.callId,
      type: data.type,
      initiatorId: data.fromUserId,
      participants: [data.fromUserId],
      conversationId: data.conversationId,
      status: CallStatus.RINGING,
      startedAt: Date.now(),
    };

    useCallStore.getState().setIncomingCall(callSession);

    // Show notification
    if (window.pcm?.notification) {
      window.pcm.notification.show(
        'Incoming Call',
        `${data.type === CallType.VIDEO ? 'Video' : 'Audio'} call from ${data.fromUserId.slice(0, 8)}...`
      );
    }
  }

  private async handleCallAccepted(data: { callId: string; fromUserId: string }) {
    // Update call status
    const store = useCallStore.getState();
    if (store.activeCall) {
      store.setActiveCall({ ...store.activeCall, status: CallStatus.ACTIVE });
    }

    // Now that call is accepted, we need Recv transport to see the other person
    await this.createRecvTransport();
  }

  private async handleNewProducer(data: { producerId: string; userId: string; kind: 'audio' | 'video' }) {
    if (!this.recvTransport) {
      await this.createRecvTransport();
    }
    await this.consume(data.producerId, data.userId);
  }

  private handleCallRejected(data: { callId: string }) {
    this.cleanup();
    useCallStore.getState().setActiveCall(null);
  }

  private handleCallEnded(data: { callId: string }) {
    this.cleanup();
    useCallStore.getState().setActiveCall(null);
    useCallStore.getState().setIncomingCall(null);
    this.onCallEndCallback?.();
  }

  private cleanup() {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.remoteStreams.clear();
    
    this.producers.forEach(p => p.close());
    this.producers.clear();
    this.consumers.forEach(c => c.close());
    this.consumers.clear();
    
    this.sendTransport?.close();
    this.sendTransport = null;
    this.recvTransport?.close();
    this.recvTransport = null;
    
    this.callId = null;
    this.conversationId = null;
    useCallStore.getState().setActiveCall(null);
  }

  private attachTransportLifecycle(transport: Transport) {
    transport.on('connectionstatechange', (state) => {
      if (state === 'failed' || state === 'disconnected') {
        this.restartIce(transport).catch((err) => logError('Calls', 'ICE restart failed:', err));
      }
      if (state === 'closed') {
        logDebug('Calls', `Transport ${transport.id} closed`);
      }
    });
  }

  private async restartIce(transport: Transport) {
    const ws = getWSService();
    if (!ws) return;
    const response = await ws.send(WSEventType.SFU_RESTART_ICE, { transportId: transport.id }, true) as SfuRestartIceResponse;
    await transport.restartIce({ iceParameters: response.iceParameters as types.IceParameters });
  }
}

// Singleton
let callService: CallService | null = null;

export function getCallService(): CallService {
  if (!callService) {
    callService = new CallService();
  }
  return callService;
}

// For backward compatibility if needed, but getCallService is preferred
export const createCallService = getCallService;
