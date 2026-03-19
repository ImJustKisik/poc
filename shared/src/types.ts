// ============================================================
// PCM Protocol — Shared Types
// ============================================================

// ---- User & Identity ----

export interface UserIdentity {
  userId: string;
  publicKey: string;        // Ed25519 public key (base64)
  signedPreKey: PreKey;
  oneTimePreKeys: PreKey[];
  displayName: string;
  avatar?: string;
  createdAt: number;
}

export interface PreKey {
  keyId: number;
  publicKey: string;        // X25519 public key (base64)
  signature?: string;       // Ed25519 signature (base64)
}

export interface SignedPreKey extends PreKey {
  signature: string;
}

export interface KeyBundle {
  identityKey: string;
  signedPreKey: SignedPreKey;
  oneTimePreKey?: PreKey;
}

// ---- Authentication ----

export interface AuthChallenge {
  nonce: string;
  timestamp: number;
}

export interface AuthResponse {
  publicKey: string;
  signature: string;        // nonce signed with Ed25519
  timestamp: number;
}

export interface AuthResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  userId?: string;
  error?: string;
}

// ---- Messages ----

export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  VOICE = 'voice',
  FILE = 'file',
  SYSTEM = 'system',
  REACTION = 'reaction',
}

export enum MessageStatus {
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: EncryptedPayload;
  replyToId?: string;
  forwardedFromId?: string;
  status: MessageStatus;
  timestamp: number;
  editedAt?: number;
}

export interface DecryptedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  text?: string;
  media?: MediaAttachment;
  replyToId?: string;
  forwardedFromId?: string;
  status: MessageStatus;
  timestamp: number;
  editedAt?: number;
  reactions?: Reaction[];
}

export interface Reaction {
  emoji: string;
  userId: string;
  timestamp: number;
}

export interface MediaAttachment {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailUrl?: string;
  encryptionKey: string;    // AES-256-GCM key for decrypting file (base64)
  iv: string;
}

export interface EncryptedPayload {
  ciphertext: string;       // base64
  nonce?: string;           // base64
  iv?: string;              // legacy alias
  senderRatchetKey?: string;
  messageNumber?: number;
  previousChainLength?: number;
  x3dhEphemeralKey?: string;
  senderKeyId?: number;
  sessionVersion?: number;
}

// ---- Conversations ----

export enum ConversationType {
  DIRECT = 'direct',
  GROUP = 'group',
}

export interface Conversation {
  id: string;
  type: ConversationType;
  name?: string;
  avatar?: string;
  members: string[];
  createdBy: string;
  createdAt: number;
  lastMessageAt?: number;
  lastMessage?: DecryptedMessage;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  existing?: boolean;
}

// ---- WebSocket Protocol ----

export enum WSEventType {
  // Connection
  PING = 'ping',
  PONG = 'pong',

  // Auth
  AUTH_CHALLENGE = 'auth:challenge',
  AUTH_RESPONSE = 'auth:response',
  AUTH_RESULT = 'auth:result',

  // Messages
  MESSAGE_SEND = 'msg:send',
  MESSAGE_RECEIVED = 'msg:received',
  MESSAGE_ACK = 'msg:ack',
  MESSAGE_STATUS = 'msg:status',
  MESSAGE_EDIT = 'msg:edit',
  MESSAGE_DELETE = 'msg:delete',
  MESSAGE_REACTION = 'msg:reaction',

  // Typing
  TYPING_START = 'typing:start',
  TYPING_STOP = 'typing:stop',

  // Conversations
  CONVERSATION_CREATE = 'conv:create',
  CONVERSATION_UPDATE = 'conv:update',
  CONVERSATION_DELETE = 'conv:delete',
  CONVERSATION_MEMBER_ADD = 'conv:member:add',
  CONVERSATION_MEMBER_REMOVE = 'conv:member:remove',

  // Key Exchange
  KEY_BUNDLE_REQUEST = 'key:bundle:request',
  KEY_BUNDLE_RESPONSE = 'key:bundle:response',
  KEY_BUNDLE_UPLOAD = 'key:bundle:upload',

  // Calls
  CALL_INITIATE = 'call:initiate',
  CALL_ACCEPT = 'call:accept',
  CALL_REJECT = 'call:reject',
  CALL_END = 'call:end',
  CALL_ICE_CANDIDATE = 'call:ice',
  CALL_SDP_OFFER = 'call:sdp:offer',
  CALL_SDP_ANSWER = 'call:sdp:answer',

  // SFU (Mediasoup)
  SFU_GET_ROUTER_RTP_CAPABILITIES = 'sfu:getRouterRtpCapabilities',
  SFU_CREATE_WEBRTC_TRANSPORT = 'sfu:createWebRtcTransport',
  SFU_CONNECT_WEBRTC_TRANSPORT = 'sfu:connectWebRtcTransport',
  SFU_PRODUCE = 'sfu:produce',
  SFU_CONSUME = 'sfu:consume',
  SFU_RESTART_ICE = 'sfu:restartIce',
  SFU_PRODUCER_CLOSE = 'sfu:producerClose',
  SFU_NEW_PRODUCER = 'sfu:newProducer',
  SFU_RESUME_CONSUMER = 'sfu:resumeConsumer',

  // Presence
  PRESENCE_ONLINE = 'presence:online',
  PRESENCE_OFFLINE = 'presence:offline',

  // Error
  ERROR = 'error',
}



export interface WSMessage<T = unknown> {
  event: WSEventType;
  data: T;
  id?: string;              // Message correlation ID
  timestamp: number;
}

export interface WsErrorPayload {
  code: string;
  message: string;
  requestId?: string;
}

// ---- Calls ----

export enum CallType {
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum CallStatus {
  RINGING = 'ringing',
  ACTIVE = 'active',
  ENDED = 'ended',
  MISSED = 'missed',
  REJECTED = 'rejected',
}

export interface CallSession {
  callId: string;
  type: CallType;
  initiatorId: string;
  participants: string[];
  conversationId: string;
  status: CallStatus;
  startedAt: number;
  endedAt?: number;
}

export interface CallSignal {
  callId: string;
  fromUserId: string;
  toUserId: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

// ---- SFU ----

export interface SfuIceParameters {
  usernameFragment: string;
  password: string;
  iceLite?: boolean;
}

export interface SfuIceCandidate {
  foundation: string;
  priority: number;
  ip: string;
  protocol: 'udp' | 'tcp';
  port: number;
  type: string;
  tcpType?: string;
}

export interface SfuDtlsFingerprint {
  algorithm: string;
  value: string;
}

export interface SfuDtlsParameters {
  role?: 'auto' | 'client' | 'server';
  fingerprints: SfuDtlsFingerprint[];
}

export interface SfuSctpParameters {
  port: number;
  OS: number;
  MIS: number;
  maxMessageSize: number;
}

export interface SfuRtcpParameters {
  cname?: string;
  reducedSize?: boolean;
  mux?: boolean;
}

export interface SfuRtpCodecParameters {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  parameters?: Record<string, unknown>;
  rtcpFeedback?: Array<{ type: string; parameter?: string }>;
}

export interface SfuRtpHeaderExtensionParameters {
  uri:
    | 'urn:ietf:params:rtp-hdrext:sdes:mid'
    | 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'
    | 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id'
    | 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
    | 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
    | 'urn:ietf:params:rtp-hdrext:toffset'
    | 'urn:3gpp:video-orientation'
    | 'urn:ietf:params:rtp-hdrext:framemarking'
    | 'urn:ietf:params:rtp-hdrext:framemarking-07'
    | 'urn:ietf:params:rtp-hdrext:ssrc-audio-level'
    | 'urn:ietf:params:rtp-hdrext:encrypt'
    | 'urn:ietf:params:rtp-hdrext:playout-delay'
    | 'http://www.webrtc.org/experiments/rtp-hdrext/video-content-type'
    | 'http://www.webrtc.org/experiments/rtp-hdrext/video-timing'
    | 'http://www.webrtc.org/experiments/rtp-hdrext/color-space'
    | 'urn:ietf:params:rtp-hdrext:transport-wide-cc-02';
  id: number;
  encrypt?: boolean;
  parameters?: Record<string, unknown>;
}

export interface SfuRtpEncodingParameters {
  ssrc?: number;
  rid?: string;
  codecPayloadType?: number;
  dtx?: boolean;
  scalabilityMode?: string;
  maxBitrate?: number;
  rtx?: { ssrc: number };
}

export interface SfuRtpParameters {
  mid?: string;
  codecs: SfuRtpCodecParameters[];
  headerExtensions?: SfuRtpHeaderExtensionParameters[];
  encodings?: SfuRtpEncodingParameters[];
  rtcp?: SfuRtcpParameters;
}

export interface SfuRtpCapabilities {
  codecs?: unknown[];
  headerExtensions?: unknown[];
}

export interface SfuTransportOptions {
  id: string;
  iceParameters: SfuIceParameters;
  iceCandidates: SfuIceCandidate[];
  dtlsParameters: SfuDtlsParameters;
  sctpParameters?: SfuSctpParameters;
}

export interface SfuProducerOptions {
  id: string;
}

export interface SfuConsumerOptions {
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: SfuRtpParameters;
  type: string;
}

export interface MessageSendPayload {
  id: string;
  conversationId: string;
  recipientIds: string[];
  encryptedPayloads: Record<string, EncryptedPayload>;
  messageType: MessageType;
  timestamp: number;
}

export interface MessageReceivedPayload {
  id: string;
  conversationId: string;
  senderId: string;
  content: EncryptedPayload;
  type: MessageType;
  timestamp: number;
}

export interface MessageStatusPayload {
  messageId: string;
  status: MessageStatus;
  targetUserId?: string;
  recipientId?: string;
}

export interface KeyBundleRequestPayload {
  targetUserId: string;
}

export interface KeyBundleResponsePayload extends KeyBundleRequestPayload {
  identityKey: string;
  signedPreKey: SignedPreKey;
  oneTimePreKey?: PreKey;
}

export interface KeyBundleUploadPayload {
  oneTimePreKeys?: Array<{ keyId: number; publicKey: string }>;
  signedPreKey?: { keyId: number; publicKey: string; signature: string };
}

export interface CallInitiatePayload {
  callId: string;
  conversationId: string;
  toUserId?: string;
  participants?: string[];
  type: CallType;
}

export interface CallAcceptPayload {
  callId: string;
  conversationId: string;
  toUserId?: string;
  participants?: string[];
  fromUserId?: string;
}

export interface CallEndPayload {
  callId: string;
  conversationId?: string;
  toUserId?: string;
  participants?: string[];
}

export interface SfuGetRouterRtpCapabilitiesRequest {
  conversationId: string;
}

export interface SfuCreateWebRtcTransportRequest {
  conversationId: string;
}

export interface SfuConnectWebRtcTransportRequest {
  transportId: string;
  dtlsParameters: SfuDtlsParameters;
}

export interface SfuProduceRequest {
  transportId: string;
  kind: 'audio' | 'video';
  rtpParameters: SfuRtpParameters;
}

export interface SfuConsumeRequest {
  transportId: string;
  producerId: string;
  rtpCapabilities: SfuRtpCapabilities;
}

export interface SfuResumeConsumerRequest {
  consumerId: string;
}

export interface SfuRestartIceRequest {
  transportId: string;
}

export interface SfuRestartIceResponse {
  transportId: string;
  iceParameters: SfuIceParameters;
}

export interface SfuNewProducerPayload {
  producerId: string;
  userId: string;
  kind: 'audio' | 'video';
}


// ---- Presence ----

export enum UserStatus {
  ONLINE = 'online',
  AWAY = 'away',
  OFFLINE = 'offline',
}

export interface UserPresence {
  userId: string;
  status: UserStatus;
  lastSeen: number;
  customStatus?: string;
}

// ---- File Upload ----

export interface FileUploadRequest {
  fileName: string;
  mimeType: string;
  size: number;
  encryptedSize: number;
  conversationId: string;
}

export interface FileUploadResponse {
  fileId: string;
  size: number;
  downloadUrl?: string;
}

// ---- Settings ----

export interface UserSettings {
  displayName: string;
  avatar?: string;
  customStatus?: string;
  notifications: {
    enabled: boolean;
    sound: boolean;
    preview: boolean;
  };
  privacy: {
    showOnlineStatus: boolean;
    showLastSeen: boolean;
    readReceipts: boolean;
  };
  appearance: {
    theme: 'dark' | 'light' | 'system';
    fontSize: 'small' | 'medium' | 'large';
    chatBackground?: string;
  };
}

// ---- P2P ----

export interface PeerInfo {
  userId: string;
  peerId: string;
  publicKey: string;
  addresses: string[];
}

// ---- API Responses ----

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
