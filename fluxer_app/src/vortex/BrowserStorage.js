// SPDX-License-Identifier: AGPL-3.0-or-later
// Fluxer captures and removes browser storage globals during production startup.
// Keep the captured factory private to the account and encryption modules.
let factory;
export function setVortexIndexedDB(value) {factory=value;}
export function getVortexIndexedDB() {
  const value=factory===undefined?globalThis.indexedDB:factory;
  if(!value)throw new Error('Private device storage is unavailable. Allow browser storage for this Node.');
  return value;
}
