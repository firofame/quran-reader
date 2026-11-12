export interface NoticeState {
	message: string;
	persistent: boolean;
}

export function Notice({ notice }: { notice: NoticeState | null }) {
	return (
		<div id="notice" className="notice" role="status" hidden={!notice}>
			{notice?.message}
		</div>
	);
}
