import type {GatewayWireTransport, GatewayWireTransportEvents} from '@app/features/gateway/transport/GatewayWireTransport';
export class VortexGateway implements GatewayWireTransport {
  constructor(url: string);
  readonly kind: 'browser';
  readonly readyState: number;
  start(): void;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  dispose(): void;
  on<K extends keyof GatewayWireTransportEvents>(event: K, callback: GatewayWireTransportEvents[K]): () => void;
}
