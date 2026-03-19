// ============================================================
// PCM Client — Notification Service
// ============================================================

import { NOTIFICATION_SOUND_DATA_URI } from '../config';

class NotificationService {
  private hasPermission: boolean = false;
  private audio: HTMLAudioElement | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      this.hasPermission = Notification.permission === 'granted';
    }
    this.audio = new Audio(NOTIFICATION_SOUND_DATA_URI);
  }

  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    
    const permission = await Notification.requestPermission();
    this.hasPermission = permission === 'granted';
    return this.hasPermission;
  }

  notify(title: string, options: NotificationOptions = {}): Notification | null {
    if (!this.hasPermission) return null;

    // Don't notify if window is focused
    if (document.hasFocus()) return null;

    const notification = new Notification(title, {
      icon: '/icon.png', // Assuming we have one
      ...options,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    if (this.audio) {
      this.audio.play().catch(() => {}); // Handle autoplay block
    }

    return notification;
  }

  playMessageSound() {
    if (this.audio && !document.hasFocus()) {
       this.audio.play().catch(() => {});
    }
  }
}

export const notifications = new NotificationService();
export default notifications;
