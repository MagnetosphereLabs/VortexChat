export function localKey(): Promise<CryptoKey>;
export function sealLocal(scope: string, key: string, value: string): Promise<string>;
export function openLocal(scope: string, key: string, value: string): Promise<string>;
