const isDebugEnabled =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.MODE !== 'test' &&
  Boolean(import.meta.env?.DEV || import.meta.env?.VITE_ENABLE_DEBUG_LOGS === 'true');

export function logDebug(scope: string, ...args: unknown[]) {
  if (isDebugEnabled) {
    console.log(`[${scope}]`, ...args);
  }
}

export function logError(scope: string, ...args: unknown[]) {
  console.error(`[${scope}]`, ...args);
}
