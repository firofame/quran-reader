import type { TodayStats } from "../lib/reading-data";

export interface PrayerCountdown {
	name: string;
	kind: string;
	remaining: string;
}

interface DailyPanelProps {
	today: TodayStats;
	countdown: PrayerCountdown | null;
	rukuProgress: { value: number; max: number } | null;
}

export function DailyPanel({ today, countdown, rukuProgress }: DailyPanelProps) {
	return (
		<section id="daily-panel" className="daily-panel" aria-label="Reading progress">
			<div className="daily-panel-main">
				<div className="daily-panel-copy">
					<span id="today-progress" className="today-progress">
						Today: <span id="today-completed">{today.completed}</span> / <span id="today-target">{today.target}</span> Ruku completed<span id="today-bonus" className="today-bonus">{today.bonus ? ` · +${today.bonus} bonus` : ""}</span>
					</span>
					<span id="target-reached-label" className="target-reached-label" hidden={!today.reached}>
						{today.bonus ? `Target reached · +${today.bonus} bonus` : "Target reached"}
					</span>
				</div>
				{countdown && (
					<div id="prayer-countdown" className="prayer-countdown">
						<span className="prayer-countdown-name">{countdown.name}</span>
						<span className="prayer-countdown-detail">{countdown.kind} in</span>
						<span className="prayer-countdown-time">{countdown.remaining}</span>
					</div>
				)}
			</div>
			<progress
				id="ruku-progress"
				className="ruku-progress"
				max={rukuProgress?.max ?? 7}
				value={rukuProgress?.value ?? 1}
				aria-label="Ruku reading progress"
				hidden={!rukuProgress}
			/>
		</section>
	);
}
