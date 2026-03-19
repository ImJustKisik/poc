// ============================================================
// PCM Client — Global State (Zustand)
// ============================================================

import { create } from 'zustand';
import { MessageStatus, type DecryptedMessage, type Conversation, type UserPresence, type UserSettings, type CallSession } from '@pcm/shared';
import { DoubleRatchetSession } from '../services/crypto';
import { resolveServerUrl } from '../config';

type StoredRatchetSession = DoubleRatchetSession;

// ---- Auth Store ----
interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  publicKey: string | null;
  secretKey: string | null; // Added
  token: string | null;
  refreshToken: string | null;
  displayName: string | null;
  serverUrl: string;
  login: (data: { userId: string; publicKey: string; secretKey: string; token: string; refreshToken: string; displayName: string; serverUrl: string }) => void;
  logout: () => void;
  setToken: (token: string) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  userId: null,
  publicKey: null,
  secretKey: null,
  token: null,
  refreshToken: null,
  displayName: null,
  serverUrl: resolveServerUrl(),
  login: (data) => set({ isAuthenticated: true, ...data }),
  logout: () => set((state) => ({
    isAuthenticated: false,
    userId: null,
    publicKey: null,
    secretKey: null,
    token: null,
    refreshToken: null,
    displayName: null,
    serverUrl: state.serverUrl,
  })),
  setToken: (token) => set({ token }),
}));

// ---- Conversations Store ----
interface ConversationsState {
  conversations: Conversation[];
  activeConversationId: string | null;
  setConversations: (convs: Conversation[]) => void;
  setActiveConversation: (id: string | null) => void;
  addConversation: (conv: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  updateLastMessage: (conversationId: string, message: DecryptedMessage) => void;
  incrementUnread: (conversationId: string) => void;
  resetUnread: (conversationId: string) => void;
  reset: () => void;
}

export const useConversationsStore = create<ConversationsState>((set) => ({
  conversations: [],
  activeConversationId: null,
  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  addConversation: (conv) => set((s) => ({
    conversations: s.conversations.some(existing => existing.id === conv.id)
      ? s.conversations
      : [conv, ...s.conversations],
  })),
  updateConversation: (id, updates) => set((s) => ({
    conversations: s.conversations.map(c => c.id === id ? { ...c, ...updates } : c),
  })),
  updateLastMessage: (conversationId, message) => set((s) => ({
    conversations: s.conversations.map(c =>
      c.id === conversationId ? { ...c, lastMessage: message, lastMessageAt: message.timestamp } : c
    ).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
  })),
  incrementUnread: (conversationId) => set((s) => ({
    conversations: s.conversations.map(c =>
      c.id === conversationId ? { ...c, unreadCount: c.unreadCount + 1 } : c
    ),
  })),
  resetUnread: (conversationId) => set((s) => ({
    conversations: s.conversations.map(c =>
      c.id === conversationId ? { ...c, unreadCount: 0 } : c
    ),
  })),
  reset: () => set({ conversations: [], activeConversationId: null }),
}));

// ---- Messages Store ----
interface MessagesState {
  messages: Record<string, DecryptedMessage[]>; // conversationId -> messages
  addMessage: (conversationId: string, message: DecryptedMessage) => void;
  setMessages: (conversationId: string, messages: DecryptedMessage[]) => void;
  updateMessageStatus: (conversationId: string, messageId: string, status: MessageStatus) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  reset: () => void;
}

export const useMessagesStore = create<MessagesState>((set) => ({
  messages: {},
  addMessage: (conversationId, message) => set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: [...(s.messages[conversationId] || []), message],
    },
  })),
  setMessages: (conversationId, messages) => set((s) => ({
    messages: { ...s.messages, [conversationId]: messages },
  })),
  updateMessageStatus: (conversationId, messageId, status) => set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: (s.messages[conversationId] || []).map(m =>
        m.id === messageId ? { ...m, status } : m
      ),
    },
  })),
  deleteMessage: (conversationId, messageId) => set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: (s.messages[conversationId] || []).filter(m => m.id !== messageId),
    },
  })),
  reset: () => set({ messages: {} }),
}));

// ---- Presence Store ----
interface PresenceState {
  presence: Record<string, UserPresence>;
  setPresence: (userId: string, presence: UserPresence) => void;
  setMultiplePresence: (presenceMap: Record<string, UserPresence>) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  presence: {},
  setPresence: (userId, presence) => set((s) => ({
    presence: { ...s.presence, [userId]: presence },
  })),
  setMultiplePresence: (presenceMap) => set((s) => ({
    presence: { ...s.presence, ...presenceMap },
  })),
  reset: () => set({ presence: {} }),
}));

// ---- Call Store ----
interface CallState {
  activeCall: CallSession | null;
  incomingCall: CallSession | null;
  remoteStreams: Record<string, MediaStream>; // userId -> MediaStream
  isMuted: boolean;
  isVideoEnabled: boolean;
  setActiveCall: (call: CallSession | null) => void;
  setIncomingCall: (call: CallSession | null) => void;
  setRemoteStream: (userId: string, stream: MediaStream | null) => void;
  setRemoteStreams: (streams: Record<string, MediaStream>) => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  reset: () => void;
}


export const useCallStore = create<CallState>((set) => ({
  activeCall: null,
  incomingCall: null,
  remoteStreams: {},
  isMuted: false,
  isVideoEnabled: true,
  setActiveCall: (call) => set({ activeCall: call }),
  setIncomingCall: (call) => set({ incomingCall: call }),
  setRemoteStream: (userId, stream) => set((s) => {
    const next = { ...s.remoteStreams };
    if (stream) next[userId] = stream;
    else delete next[userId];
    return { remoteStreams: next };
  }),
  setRemoteStreams: (streams) => set({ remoteStreams: streams }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  toggleVideo: () => set((s) => ({ isVideoEnabled: !s.isVideoEnabled })),
  reset: () => set({
    activeCall: null,
    incomingCall: null,
    remoteStreams: {},
    isMuted: false,
    isVideoEnabled: true,
  }),
}));

// ---- Session Store (Crypto Sessions) ----
interface SessionState {
  sessions: Record<string, StoredRatchetSession>; // conversationId -> DoubleRatchetSession instance
  setSession: (conversationId: string, session: StoredRatchetSession) => void;
  removeSession: (conversationId: string) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: {},
  setSession: (conversationId, session) => set((s) => ({
    sessions: { ...s.sessions, [conversationId]: session },
  })),
  removeSession: (conversationId) => set((s) => {
    const next = { ...s.sessions };
    delete next[conversationId];
    return { sessions: next };
  }),
  reset: () => set({ sessions: {} }),
}));

// ---- UI Store ----
interface UIState {
  showSettings: boolean;
  showEmojiPanel: boolean;
  replyingTo: DecryptedMessage | null;
  searchQuery: string;
  messageSearchQuery: string;
  showMessageSearch: boolean;
  typingUsers: Record<string, string[]>; // conversationId -> userIds
  setShowSettings: (show: boolean) => void;
  setShowEmojiPanel: (show: boolean) => void;
  setShowMessageSearch: (show: boolean) => void;
  setReplyingTo: (message: DecryptedMessage | null) => void;
  setSearchQuery: (query: string) => void;
  setMessageSearchQuery: (query: string) => void;
  setTypingUsers: (conversationId: string, userIds: string[]) => void;
  reset: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  showSettings: false,
  showEmojiPanel: false,
  replyingTo: null,
  searchQuery: '',
  messageSearchQuery: '',
  showMessageSearch: false,
  typingUsers: {},
  setShowSettings: (show) => set({ showSettings: show }),
  setShowEmojiPanel: (show) => set({ showEmojiPanel: show }),
  setShowMessageSearch: (show) => set({ showMessageSearch: show }),
  setReplyingTo: (message) => set({ replyingTo: message }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setMessageSearchQuery: (query) => set({ messageSearchQuery: query }),
  setTypingUsers: (conversationId, userIds) => set((s) => ({
    typingUsers: { ...s.typingUsers, [conversationId]: userIds },
  })),
  reset: () => set({
    showSettings: false,
    showEmojiPanel: false,
    replyingTo: null,
    searchQuery: '',
    messageSearchQuery: '',
    showMessageSearch: false,
    typingUsers: {},
  }),
}));
