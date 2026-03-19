// ============================================================
// PCM Client — Type Declarations for Preload API
// ============================================================

export {};

declare global {
  interface Window {
    pcm: {
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
      };
      keys: {
        store: (data: string) => Promise<boolean>;
        load: () => Promise<string | null>;
        exists: () => Promise<boolean>;
      };
      notification: {
        show: (title: string, body: string) => void;
      };
      app: {
        getDataPath: () => Promise<string>;
      };
    };
  }
}
