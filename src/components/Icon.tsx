import type { ReactElement } from "react";

const STROKE_ICONS = {
	book: <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15" />,
	search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
	moon: <path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z" />,
	sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
	menu: <path d="M4 6h16M4 12h16M4 18h16" />,
	close: <path d="m6 6 12 12M6 18 18 6" />,
	left: <path d="m14 6-6 6 6 6M8 12h12" />,
	right: <path d="m10 6 6 6-6 6M16 12H4" />,
} satisfies Record<string, ReactElement>;

const FILL_ICONS = {
	play: <path d="M8 5v14l11-7z" />,
	pause: <path d="M6 5h4v14H6zM14 5h4v14h-4z" />,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof STROKE_ICONS | keyof typeof FILL_ICONS;

export function Icon({ name }: { name: IconName }) {
	const filled = name in FILL_ICONS;
	const content = filled ? FILL_ICONS[name as keyof typeof FILL_ICONS] : STROKE_ICONS[name as keyof typeof STROKE_ICONS];
	return (
		<svg
			viewBox="0 0 24 24"
			fill={filled ? "currentColor" : "none"}
			stroke={filled ? "none" : "currentColor"}
			strokeWidth={filled ? undefined : 1.6}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{content}
		</svg>
	);
}
