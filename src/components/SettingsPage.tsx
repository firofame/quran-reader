import { findRuku, pendingEarlierRukus, PRAYERS } from "../lib/reading-data";
import type { PrayerId, ReadingData, ReadingSettings } from "../lib/reading-data";
import type { Position } from "../lib/reader";
import { rukus } from "../lib/quran";

interface SettingsPageProps {
	readingData: ReadingData;
	position: Position;
	onMarkEarlierRukus: () => void;
	onPrayerTimeChange: (prayerId: PrayerId, field: "adhan" | "iqama", time: string) => void;
	onRemindersChange: (enabled: boolean) => void;
}

export function SettingsPage({ readingData, position, onMarkEarlierRukus, onPrayerTimeChange, onRemindersChange }: SettingsPageProps) {
	const currentRuku = findRuku(position, rukus);
	const pending = pendingEarlierRukus(readingData, currentRuku?.id ?? null, rukus);
	const settings: ReadingSettings = readingData.settings;

	return (
		<section id="settings-page" className="secondary-page">
			<header className="page-heading">
				<span className="eyebrow">MAKE IT YOURS</span>
				<h1>Settings</h1>
				<p>Choose a pace and a reading setup that feels sustainable.</p>
			</header>
			<section id="reading-history-card" className="page-card" hidden={pending === 0}>
				<h2>Reading history</h2>
				<div id="mark-read-block" className="reading-history-block">
					<button id="mark-read-btn" type="button" className="secondary-button" onClick={onMarkEarlierRukus}>
						Mark {pending} earlier ruku{pending === 1 ? "" : "s"} as read
					</button>
					<p className="muted-copy">For when you have already read further on another device. It catches up the overall progress and the lifetime totals. Daily activity stays as it is, because the days are not known.</p>
				</div>
			</section>
			<section className="page-card">
				<div className="card-heading-row">
					<div>
						<h2>Daily prayers</h2>
						<p>The five daily prayers, with their adhan and iqama times. Times follow your device’s local time.</p>
					</div>
				</div>
				<div id="prayer-editor" className="prayer-editor">
					<div className="prayer-editor-head">
						<span>Prayer</span>
						<span>Adhan</span>
						<span>Iqama</span>
					</div>
					{PRAYERS.map(prayer => (
						<div key={prayer.id} className="prayer-editor-row" data-prayer-id={prayer.id}>
							<span className="prayer-editor-name">{prayer.name}</span>
							<input
								type="time"
								value={settings.prayerTimes[prayer.id].adhan}
								aria-label={`${prayer.name} adhan time`}
								onChange={event => onPrayerTimeChange(prayer.id, "adhan", event.target.value)}
							/>
							<input
								type="time"
								value={settings.prayerTimes[prayer.id].iqama}
								aria-label={`${prayer.name} iqama time`}
								onChange={event => onPrayerTimeChange(prayer.id, "iqama", event.target.value)}
							/>
						</div>
					))}
				</div>
				<label className="setting-check">
					<input
						id="reminders-setting"
						type="checkbox"
						checked={settings.remindersEnabled}
						onChange={event => onRemindersChange(event.target.checked)}
					/>
					Browser reminders at the adhan and 5 minutes before iqama
				</label>
				<p className="muted-copy">Browser reminders only fire while the browser is running.</p>
			</section>
		</section>
	);
}
