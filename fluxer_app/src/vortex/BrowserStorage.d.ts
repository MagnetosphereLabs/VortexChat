export function setVortexIndexedDB(value: IDBFactory | null): void;
export function getVortexIndexedDB(): IDBFactory;
export function getVortexDeviceKey(purpose: 'account' | 'local'): Promise<CryptoKey>;
