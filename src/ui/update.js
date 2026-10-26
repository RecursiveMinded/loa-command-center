import { useState, useEffect } from 'preact/hooks';
import { native, onEvent, isDesktop } from './api.js';

/** Live status of the automatic updater (desktop only; null in the browser). */
export function useUpdate() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    if (!isDesktop) return undefined;
    native('updateStatus').then(setSt).catch(() => {});
    return onEvent('update', setSt);
  }, []);
  return st;
}

export const checkForUpdates = () => native('checkForUpdates');
export const installUpdate = () => native('installUpdate');
