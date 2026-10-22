import type {RestRequestOptions, RestResponse} from '@app/features/platform/types/TransportTypes';
export function vortexOrigin(endpoint: string | null | undefined): string | null;
export function verifyNode(origin: string): Promise<{protocol: string; version: number; node: string}>;
export function vortexRequest<T>(origin: string, method: string, path: string, options: RestRequestOptions, token?: string | null): Promise<RestResponse<T>>;
