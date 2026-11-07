import makeInlineReplaceExtension, { isNodeRevealed, updateInlineDecorationsEffect } from './makeInlineReplaceExtension';
import { SyntaxNodeRef } from '@lezer/common';
import { EditorSelection, EditorState, Facet, SelectionRange, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView } from '@codemirror/view';
import { ParentTags, ReplacementExtension } from '../types';

const hideDecoration = Decoration.mark({
	class: 'cm-hidden',
});
// Don't fully hide replaced Markdown:
// - Hiding text with 'display: none' causes selection to behave unexpectedly
// - Screen readers skip text with 'display: none', which can lead to a confusing editing experience
const hiddenStyles = EditorView.theme({
	['& .cm-hidden']: {
		// This needs to be non-zero to avoid selection issues. To avoid screen reader issues
		// the width also needs to be >= 1px.
		width: '1px',
		height: '1em',
		marginRight: '-0.9px',

		opacity: '0',
		display: 'inline-block',
		whiteSpace: 'nowrap',
		overflow: 'hidden',

		// Decrease the size of the content: Work around cursor placement issues when a
		// line ends with a long hidden decoration. Overflowing text is still measured, so
		// without a strong scale, selections ending after hidden text are drawn too wide.
		transform: 'scale(0.001, 1)',
	},
});

type Options = Pick<ReplacementExtension, 'getRevealStrategy'|'getDecorationRange'> & {
	shouldHide: (node: SyntaxNodeRef, state: EditorState, parentTags: ParentTags)=> boolean;
	// Range of the formatted element that the hidden node belongs to. Defaults to the node's parent.
	getFormattedRange?: (node: SyntaxNodeRef, state: EditorState)=> [number, number]|null;
};

type GetActivePluginOptions = (node: SyntaxNodeRef, state: EditorState, parentTags: ParentTags)=> Options|undefined;

interface HiddenRange {
	from: number;
	to: number;
	parentFrom: number;
	parentTo: number;
}

const hiddenRangesAt = (state: EditorState, pos: number, getActivePluginOptions: GetActivePluginOptions) => {
	const result: HiddenRange[] = [];
	const parentTags = new Map<string, number>();
	// Scan the whole line: a decoration range can extend beyond its node (e.g. the space after "##").
	const line = state.doc.lineAt(pos);
	syntaxTree(state).iterate({
		from: line.from,
		to: line.to,
		enter: node => {
			parentTags.set(node.name, (parentTags.get(node.name) ?? 0) + 1);
			const options = getActivePluginOptions(node, state, parentTags);
			if (!options || isNodeRevealed(node, state, options.getRevealStrategy?.(node, state, parentTags) ?? 'line')) return;
			const parent = node.node.parent;
			const formattedRange = options.getFormattedRange?.(node, state) ?? (parent ? [parent.from, parent.to] : null);
			if (!formattedRange) return;

			const range = options.getDecorationRange?.(node, state, parentTags) ?? [node.from, node.to];
			if (range.length !== 2 || (range[0] !== pos && range[1] !== pos)) return;
			if (range[0] < line.from || range[1] > line.to) return;
			result.push({ from: range[0], to: range[1], parentFrom: formattedRange[0], parentTo: formattedRange[1] });
		},
		leave: node => {
			parentTags.set(node.name, (parentTags.get(node.name) ?? 0) - 1);
		},
	});
	return result;
};

// Hidden marks are nearly zero-width, so a drag that crosses a formatted node's edge often stops just
// inside a mark, leaving it unselected once revealed on mouseup (see #16546). Expand over such marks.
const expandRangeOverHiddenMarks = (state: EditorState, range: SelectionRange, getActivePluginOptions: GetActivePluginOptions) => {
	let { from, to } = range;

	// Repeat to handle adjacent marks from nested nodes (e.g. ***text***)
	for (let i = 0; i < 10; i++) {
		const rangesAtFrom = hiddenRangesAt(state, from, getActivePluginOptions);
		const rangesAtTo = hiddenRangesAt(state, to, getActivePluginOptions);

		const closingMark = rangesAtTo.find(hidden => hidden.from === to && hidden.to > to && (
			from < hidden.parentFrom || (from === hidden.parentFrom && rangesAtFrom.some(other => other.from === from))
		));
		const openingMark = rangesAtFrom.find(hidden => hidden.to === from && hidden.from < from && (
			to > hidden.parentTo || (to === hidden.parentTo && rangesAtTo.some(other => other.to === to))
		));
		if (!closingMark && !openingMark) break;

		if (closingMark) to = closingMark.to;
		if (openingMark) from = openingMark.from;
	}

	if (from === range.from && to === range.to) return range;
	return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
};

// Decorations are computed from the selection before a mouse drag until mouseup, so marks are hidden
// or revealed based on this selection. Mirrors the reset logic in makeInlineReplaceExtension.
const dragStartSelectionField = StateField.define<EditorSelection|null>({
	create: () => null,
	update: (value, tr) => {
		if (tr.docChanged || tr.effects.some(effect => effect.is(updateInlineDecorationsEffect))) return null;
		if (tr.isUserEvent('select.pointer')) return value ?? tr.startState.selection;
		return value;
	},
});

const hideReplaceFacet = Facet.define<Options>({
	combine: values => values.flat(),
	enables: facet => {
		const getActivePluginOptions: GetActivePluginOptions = (node, state, parentTags) => {
			const allPluginOptions = state.facet(facet);
			return allPluginOptions.find(o => o.shouldHide(node, state, parentTags));
		};
		return [
			hiddenStyles,
			dragStartSelectionField,
			EditorState.transactionFilter.of(tr => {
				if (!tr.selection || tr.docChanged || !tr.isUserEvent('select.pointer')) return tr;
				const selection = tr.selection;
				if (selection.ranges.every(range => range.empty)) return tr;

				const dragStartSelection = tr.startState.field(dragStartSelectionField) ?? tr.startState.selection;
				const revealState = tr.startState.update({ selection: dragStartSelection }).state;
				const ranges = selection.ranges.map(range => (
					range.empty ? range : expandRangeOverHiddenMarks(revealState, range, getActivePluginOptions)
				));
				if (ranges.every((range, index) => range === selection.ranges[index])) return tr;

				return [tr, { selection: EditorSelection.create(ranges, selection.mainIndex) }];
			}),
			makeInlineReplaceExtension({
				createDecoration: (node, state, parentTags) => {
					if (getActivePluginOptions(node, state, parentTags)) {
						return hideDecoration;
					}
					return null;
				},
				getDecorationRange: (node, state, parentTags) => {
					const options = getActivePluginOptions(node, state, parentTags);
					return options?.getDecorationRange?.(node, state, parentTags);
				},
				getRevealStrategy: (node, state, parentTags) => {
					const options = getActivePluginOptions(node, state, parentTags);
					return options?.getRevealStrategy?.(node, state, parentTags);
				},
				mergeNeighbors: true,
			}),
		];
	},
});

const makeHideReplaceExtension = (options: Options) => [
	hideReplaceFacet.of(options),
];

export default makeHideReplaceExtension;
