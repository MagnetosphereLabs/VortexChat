// SPDX-License-Identifier: AGPL-3.0-or-later

import { msg } from '@lingui/core/macro';
import type React from 'react';

export const APPLICATION_ICON_DESCRIPTOR = msg({
	message: '{productName} application icon',
	comment: 'Accessible label for the Fluxer application icon.',
});

export const FluxerIconMark = (props: React.SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 512 512"
		role="img"
		data-flx="ui.icons.fluxer-icon.img"
		{...props}
	>
		<rect fill="var(--brand-primary)" height={512} rx={256} width={512} data-flx="ui.icons.fluxer-icon.rect" />
		<g fill="none" stroke="var(--brand-primary-fill)" strokeWidth="30" strokeLinecap="round">
			<path d="M374 161C322 100 213 96 150 157S82 318 144 377" />
			<path d="M138 351C195 414 304 416 367 355S435 195 373 136" />
			<path d="M320 202C285 167 231 166 197 201S163 290 199 321" />
			<path d="M193 309C228 345 282 346 316 311S350 223 314 191" />
		</g>
		<circle cx="256" cy="256" r="24" fill="var(--brand-primary-fill)" />
	</svg>
);
