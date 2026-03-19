// ============================================================
// PCM Server — Mediasoup SFU Service
// ============================================================

import * as mediasoup from 'mediasoup';
import { cpus } from 'os';
import { serverConfig } from '../config.js';

// Type aliases for convenience
type Worker = mediasoup.types.Worker;
type Router = mediasoup.types.Router;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;
type RtpCapabilities = mediasoup.types.RtpCapabilities;

// ---- Config ----
const MEDIA_CODECS: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    preferredPayloadType: 96,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
];

const LISTEN_IPS: mediasoup.types.TransportListenIp[] = [
  {
    ip: serverConfig.sfuListenIp,
    announcedIp: serverConfig.sfuAnnouncedIp,
  },
];

class SfuService {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private routers = new Map<string, Router>(); // conversationId -> Router
  private transports = new Map<string, WebRtcTransport & { userId: string, conversationId: string }>(); 
  private producers = new Map<string, Producer & { userId: string, conversationId: string }>();
  private consumers = new Map<string, Consumer & { userId: string, conversationId: string }>();


  async init() {
    const numWorkers = Math.max(cpus().length, 2);

    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: serverConfig.sfuMinPort,
        rtcMaxPort: serverConfig.sfuMaxPort,
      });

      worker.on('died', () => {
        console.error('Mediasoup worker died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
      });

      this.workers.push(worker);
    }
  }

  private getWorker(): Worker {
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  async getOrCreateRouter(conversationId: string): Promise<Router> {
    let router = this.routers.get(conversationId);
    if (!router) {
      router = await this.getWorker().createRouter({ mediaCodecs: MEDIA_CODECS });
      this.routers.set(conversationId, router);
    }
    return router;
  }

  async createTransport(conversationId: string, userId: string): Promise<WebRtcTransport> {
    const router = await this.getOrCreateRouter(conversationId);
    const transport = await router.createWebRtcTransport({
      listenIps: LISTEN_IPS,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    }) as any;

    transport.userId = userId;
    transport.conversationId = conversationId;

    transport.on('dtlsstatechange', (dtlsState: string) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('@close', () => {
      this.transports.delete(transport.id);
    });

    this.transports.set(transport.id, transport);
    return transport;
  }

  async connectTransport(transportId: string, userId: string, dtlsParameters: any) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');
    if (transport.userId !== userId) throw new Error('Transport does not belong to user');
    await transport.connect({ dtlsParameters });
  }

  async produce(transportId: string, userId: string, kind: 'audio' | 'video', rtpParameters: any): Promise<Producer> {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');
    if (transport.userId !== userId) throw new Error('Transport does not belong to user');

    const producer = await transport.produce({ kind, rtpParameters }) as any;
    producer.userId = transport.userId;
    producer.conversationId = transport.conversationId;

    this.producers.set(producer.id, producer);

    producer.on('@close', () => {
      this.producers.delete(producer.id);
    });

    return producer;
  }

  async consume(transportId: string, userId: string, producerId: string, rtpCapabilities: RtpCapabilities): Promise<Consumer> {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');
    if (transport.userId !== userId) throw new Error('Transport does not belong to user');

    const producer = this.producers.get(producerId);
    if (!producer) throw new Error('Producer not found');
    if (producer.conversationId !== transport.conversationId) throw new Error('Producer is in another conversation');

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    }) as any;

    consumer.userId = transport.userId;
    consumer.conversationId = transport.conversationId;

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      this.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      consumer.close();
      this.consumers.delete(consumer.id);
    });

    return consumer;
  }
  
  async resumeConsumer(consumerId: string, userId: string) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) throw new Error('Consumer not found');
    if (consumer.userId !== userId) throw new Error('Consumer does not belong to user');
    await consumer.resume();
  }

  async restartIce(transportId: string, userId: string) {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');
    if (transport.userId !== userId) throw new Error('Transport does not belong to user');
    return transport.restartIce();
  }

  getTransport(transportId: string) {
    return this.transports.get(transportId);
  }

  getConsumer(consumerId: string) {
    return this.consumers.get(consumerId);
  }

  getProducers(conversationId: string, excludeUserId?: string): { producerId: string; userId: string; kind: 'audio' | 'video' }[] {
    return Array.from(this.producers.values())
      .filter(p => p.conversationId === conversationId && p.userId !== excludeUserId)
      .map(p => ({ producerId: p.id, userId: p.userId, kind: p.kind }));
  }

  async getRouterRtpCapabilities(conversationId: string): Promise<RtpCapabilities> {
    const router = await this.getOrCreateRouter(conversationId);
    return router.rtpCapabilities;
  }

  async leaveConversation(userId: string, conversationId: string) {
    // Close transports belonging to this user in this conversation
    for (const transport of this.transports.values()) {
      if (transport.userId === userId && transport.conversationId === conversationId) {
        transport.close();
      }
    }
  }

  cleanupUser(userId: string) {
    for (const transport of Array.from(this.transports.values())) {
      if (transport.userId === userId) {
        transport.close();
      }
    }

    for (const consumer of Array.from(this.consumers.values())) {
      if (consumer.userId === userId) {
        consumer.close();
      }
    }

    for (const producer of Array.from(this.producers.values())) {
      if (producer.userId === userId) {
        producer.close();
      }
    }
  }
}

export const sfuService = new SfuService();
