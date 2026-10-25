// The single place the real agora-chat browser SDK is constructed. Isolated here
// so the lifecycle controller and the hook depend on the ChatConnection
// interface (and inject a factory in tests) rather than the SDK directly.
//
// The SDK is loaded with a dynamic import only, so it lives in its own chunk
// and never ships with sign in, sign up or the shell's first paint. The hook
// awaits loadAgoraSdk() alongside the first token fetch; every Connection and
// message is built after that, so the synchronous factories below always see
// the loaded module.

import type websdk from 'agora-chat';
import type { ChatConnection, CreateConnection } from '@/lib/chat/types';

type AgoraSdk = typeof websdk;

/** SDK-level socket reconnect attempts before it reports a disconnect to the controller. */
const AUTO_RECONNECT_NUM_MAX = 10;

let sdk: AgoraSdk | null = null;
let sdkLoad: Promise<AgoraSdk> | null = null;

/** Load the agora-chat SDK chunk once; a failed load is retried on the next call. */
export function loadAgoraSdk(): Promise<AgoraSdk> {
  if (sdk !== null) return Promise.resolve(sdk);
  sdkLoad ??= import('agora-chat').then(
    (m) => (sdk = m.default),
    (error: unknown) => {
      sdkLoad = null;
      throw error;
    },
  );
  return sdkLoad;
}

/** The loaded SDK; only called once a connection exists, i.e. after loadAgoraSdk() resolved. */
export function agoraSdk(): AgoraSdk {
  if (sdk === null) throw new Error('agora-chat SDK not loaded');
  return sdk;
}

/** Construct an agora-chat Connection bound to the worker-provided App Key. */
export const createAgoraConnection: CreateConnection = (appKey): ChatConnection =>
  new (agoraSdk().connection)({
    appKey,
    delivery: true,
    autoReconnectNumMax: AUTO_RECONNECT_NUM_MAX,
  });
