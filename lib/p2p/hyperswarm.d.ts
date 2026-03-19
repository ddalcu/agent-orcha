declare module 'hyperswarm' {
  import type { Duplex } from 'stream';
  import type { EventEmitter } from 'events';

  interface SwarmOptions {
    keyPair?: Buffer;
    seed?: Buffer;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
  }

  interface PeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
  }

  interface Discovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: SwarmOptions);
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Discovery;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (socket: Duplex, info: PeerInfo) => void): this;
  }

  export default Hyperswarm;
}
