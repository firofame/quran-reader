import { useEffect, useState } from "react";

/** The current time, refreshed every second so countdowns keep ticking. */
export function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 1000);
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") setNow(new Date());
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);
	return now;
}
