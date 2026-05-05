/**
 * @jest-environment jsdom
 */

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import createTestEditor from '../testing/createTestEditor';
import wrappedLineIndentExtension, { getLineDecorationStyle, getTabReplacementWidth, isFullDocumentReplace, parseIndentPrefix } from './wrappedLineIndentExtension';

describe('wrappedLineIndentExtension', () => {
	let queuedAnimationFrames: FrameRequestCallback[] = [];

	const originalRequestMeasure = EditorView.prototype.requestMeasure;
	const originalCoordsAtPos = EditorView.prototype.coordsAtPos;
	const originalRequestAnimationFrame = global.requestAnimationFrame;
	const originalCancelAnimationFrame = global.cancelAnimationFrame;
	const defaultCharacterWidth = Object.getOwnPropertyDescriptor(EditorView.prototype, 'defaultCharacterWidth');
	const defaultLineHeight = Object.getOwnPropertyDescriptor(EditorView.prototype, 'defaultLineHeight');
	const scaleX = Object.getOwnPropertyDescriptor(EditorView.prototype, 'scaleX');
	const scaleY = Object.getOwnPropertyDescriptor(EditorView.prototype, 'scaleY');

	beforeEach(() => {
		queuedAnimationFrames = [];
		EditorView.prototype.requestMeasure = function(spec) {
			if (!spec) {
				return originalRequestMeasure.call(this);
			}

			const result = spec.read(this);
			spec.write(result, this);
		};
		EditorView.prototype.coordsAtPos = function(pos) {
			return {
				bottom: 10,
				left: pos * 10,
				right: pos * 10,
				top: 0,
				x: pos * 10,
				y: 0,
				height: 10,
				width: 0,
			} as DOMRect;
		};
		global.requestAnimationFrame = (callback: FrameRequestCallback) => {
			queuedAnimationFrames.push(callback);
			return queuedAnimationFrames.length;
		};
		global.cancelAnimationFrame = () => {};
		Object.defineProperty(EditorView.prototype, 'defaultCharacterWidth', {
			configurable: true,
			get: () => 10,
		});
		Object.defineProperty(EditorView.prototype, 'defaultLineHeight', {
			configurable: true,
			get: () => 16,
		});
		Object.defineProperty(EditorView.prototype, 'scaleX', {
			configurable: true,
			get: () => 1,
		});
		Object.defineProperty(EditorView.prototype, 'scaleY', {
			configurable: true,
			get: () => 1,
		});
	});

	afterEach(() => {
		EditorView.prototype.requestMeasure = originalRequestMeasure;
		EditorView.prototype.coordsAtPos = originalCoordsAtPos;
		global.requestAnimationFrame = originalRequestAnimationFrame;
		global.cancelAnimationFrame = originalCancelAnimationFrame;

		if (defaultCharacterWidth) {
			Object.defineProperty(EditorView.prototype, 'defaultCharacterWidth', defaultCharacterWidth);
		}
		if (defaultLineHeight) {
			Object.defineProperty(EditorView.prototype, 'defaultLineHeight', defaultLineHeight);
		}
		if (scaleX) {
			Object.defineProperty(EditorView.prototype, 'scaleX', scaleX);
		}
		if (scaleY) {
			Object.defineProperty(EditorView.prototype, 'scaleY', scaleY);
		}
	});

	test.each([
		['  - [x] task item', '  - [x] '],
		['> > 1. nested item', '> > 1. '],
		['\t\tindented text', '\t\t'],
	])('parses indent prefix for %s', (lineText, expectedPrefix) => {
		expect(parseIndentPrefix(lineText)).toEqual({ text: expectedPrefix });
	});

	it('computes tab replacement and line decoration styles', () => {
		expect(getTabReplacementWidth('abc', 4, 10)).toBe(10);
		expect(getLineDecorationStyle(24, 8)).toBe('padding-left: 32px; text-indent: -24px;');
	});

	it('detects full document replacements', () => {
		const state = EditorState.create({ doc: 'abc' });
		const replaceAllTransaction = state.update({ changes: { from: 0, to: state.doc.length, insert: 'xyz' } });
		const partialTransaction = state.update({ changes: { from: 1, to: 2, insert: 'x' } });

		expect(isFullDocumentReplace(replaceAllTransaction)).toBe(true);
		expect(isFullDocumentReplace(partialTransaction)).toBe(false);
	});

	it('adds a hanging indent line decoration after measurement', async () => {
		const editorText = '- wrapped list item';
		const editor = await createTestEditor(
			editorText,
			EditorSelection.cursor(editorText.length),
			['BulletList'],
			[wrappedLineIndentExtension],
		);

		for (const callback of queuedAnimationFrames) {
			callback(0);
		}

		const wrappedLine = editor.contentDOM.querySelector<HTMLElement>('.cm-wrapped-line-indent');
		expect(wrappedLine).not.toBeNull();
		expect(wrappedLine?.getAttribute('style')).toContain('padding-left: 20px; text-indent: -20px;');

		editor.destroy();
	});
});
