// SPDX-License-Identifier: AGPL-3.0-or-later
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {HttpMethod, RestRequestOptions, RestResponse} from '@app/features/platform/types/TransportTypes';
import {vortexRequest} from './Rest.js';

export async function dispatchVortex<T>(origin: string, method: HttpMethod, path: string, options: RestRequestOptions, token: string | null): Promise<RestResponse<T>> {
	try {
		return await vortexRequest<T>(origin, method, path, options, token);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		const detail = error as {status?: number; message?: string; code?: string};
		throw new HttpError({method, path, status: detail.status ?? 400,
			body: {message: detail.message ?? 'The encrypted request failed', code: detail.code ?? 'VORTEX_REQUEST_FAILED'}});
	}
}
