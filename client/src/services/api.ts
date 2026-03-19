// ============================================================
// PCM Client — API Service
// ============================================================

import type { ApiResponse, Conversation, FileUploadResponse } from '@pcm/shared';
import { resolveServerUrl } from '../config';

let baseUrl = resolveServerUrl();
let authToken = '';

export function configureApi(url: string, token: string) {
  baseUrl = resolveServerUrl(url);
  authToken = token;
}

export function updateApiToken(token: string) {
  authToken = token;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    },
  });

  return res.json();
}

// ---- Users ----

export async function getUser(userId: string) {
  return request<{
    id: string;
    publicKey: string;
    displayName: string;
    avatar?: string;
    customStatus?: string;
    lastSeen: number;
  }>(`/api/users/${userId}`);
}

export async function getUserByPublicKey(publicKey: string) {
  return request<{ id: string; publicKey: string; displayName: string; avatar?: string }>(
    `/api/users/key/${encodeURIComponent(publicKey)}`
  );
}

export async function updateProfile(data: { displayName?: string; avatar?: string; customStatus?: string }) {
  return request('/api/users/profile', { method: 'PUT', body: JSON.stringify(data) });
}

// ---- Conversations ----

export async function getConversations() {
  return request<Conversation[]>('/api/conversations');
}

export async function createConversation(data: { type: 'direct' | 'group'; name?: string; memberIds: string[] }) {
  return request<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify(data) });
}

export async function addConversationMembers(conversationId: string, memberIds: string[]) {
  return request<void>(`/api/conversations/${conversationId}/members`, { method: 'POST', body: JSON.stringify({ memberIds }) });
}

// ---- Files ----

export async function uploadFile(file: File, conversationId: string): Promise<ApiResponse<FileUploadResponse>> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('conversationId', conversationId);
  formData.append('fileName', file.name);
  formData.append('mimeType', file.type);

  const res = await fetch(`${baseUrl}/api/files/upload`, {
    method: 'POST',
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: formData,
  });

  return res.json();
}

export function getFileUrl(fileId: string): string {
  return `${baseUrl}/api/files/${fileId}?token=${encodeURIComponent(authToken)}`;
}

export function getApiBaseUrl(): string {
  return baseUrl;
}

// ---- Auth ----

export async function refreshAuthToken(refreshToken: string): Promise<ApiResponse<{ token: string }>> {
  return request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) });
}
