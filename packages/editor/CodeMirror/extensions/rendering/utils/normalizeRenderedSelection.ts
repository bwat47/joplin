// cspell:ignore assoc
import { EditorSelection } from '@codemirror/state';

// A hidden source range and the rendered construct it belongs to. Keep this
// information separate from decorations, which may merge adjacent markers.
export interface HiddenSyntaxRange {
	from: number;
	to: number;
	ownerFrom: number;
	ownerTo: number;
}

const normalizeRenderedSelection = (selection: EditorSelection, hiddenSyntax: readonly HiddenSyntaxRange[]) => {
	if (!hiddenSyntax.length || selection.ranges.every(range => range.empty)) return selection;

	const hidden: { from: number; to: number }[] = [];
	for (const range of [...hiddenSyntax].sort((a, b) => a.from - b.from)) {
		const previous = hidden[hidden.length - 1];
		if (previous && range.from <= previous.to) {
			previous.to = Math.max(previous.to, range.to);
		} else {
			hidden.push({ from: range.from, to: range.to });
		}
	}

	let changed = false;
	const ranges = selection.ranges.map(range => {
		if (range.empty) return range;

		let { from, to } = range;
		for (const { ownerFrom, ownerTo } of hiddenSyntax) {
			if (ownerFrom >= range.to || ownerTo <= range.from) continue;
			if (ownerFrom >= from && ownerTo <= to) continue;

			// Trim *all* hidden syntax at the owner's edges, including nested
			// constructs. Only expand when all remaining visible content is selected.
			const prefix = hidden.find(hidden => hidden.from <= ownerFrom && hidden.to > ownerFrom);
			const suffix = hidden.find(hidden => hidden.from < ownerTo && hidden.to >= ownerTo);
			const contentFrom = prefix ? Math.min(prefix.to, ownerTo) : ownerFrom;
			const contentTo = suffix ? Math.max(suffix.from, ownerFrom) : ownerTo;
			if (contentFrom < contentTo && range.from <= contentFrom && range.to >= contentTo) {
				from = Math.min(from, ownerFrom);
				to = Math.max(to, ownerTo);
			}
		}

		if (from === range.from && to === range.to) return range;
		changed = true;
		const forward = range.anchor <= range.head;
		return EditorSelection.range(forward ? from : to, forward ? to : from, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
	});
	return changed ? EditorSelection.create(ranges, selection.mainIndex) : selection;
};

export default normalizeRenderedSelection;
