import { EditorSelection } from '@codemirror/state';
import createTestEditor from '../testing/createTestEditor';
import jumpToHash from './jumpToHash';

describe('jumpToHash', () => {
	test.each([
		{
			doc: 'This is an anchor: <a id="test">Test</a>',
			expectedCursorLocation: 'This is an anchor: <a id="test">'.length,
			waitForTags: ['HTMLTag'],
		},
		{
			doc: '<div>HTML block: This is an anchor: <a id="test">Test</a></div>',
			expectedCursorLocation: '<div>HTML block: This is an anchor: <a id="test">'.length,
			waitForTags: ['HTMLBlock'],
		},
	])('should support jumping to elements with ID set to "test" (case %#)', async ({ doc: docText, expectedCursorLocation, waitForTags }) => {
		const editor = await createTestEditor(
			docText,
			EditorSelection.cursor(1),
			waitForTags,
		);
		expect(jumpToHash(editor, 'test')).toBe(true);
		const cursorPosition = editor.state.selection.main.anchor;
		expect(
			editor.state.sliceDoc(0, cursorPosition),
		).toBe(
			editor.state.sliceDoc(0, expectedCursorLocation),
		);
	});

	test('should jump to Markdown headers', async () => {
		const editor = await createTestEditor(
			'Line 1\n## Line 2',
			EditorSelection.cursor(0),
			['ATXHeading2'],
		);
		expect(jumpToHash(editor, 'line-2')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe(editor.state.doc.length);
	});

	test('should handle duplicate headings with numbered hashes', async () => {
		const docText = '## Heading\n\nSome content\n\n## Heading\n\nMore content\n\n## Heading';
		const editor = await createTestEditor(
			docText,
			EditorSelection.cursor(0),
			['ATXHeading2'],
		);

		// First heading: #heading
		expect(jumpToHash(editor, 'heading')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe('## Heading'.length);

		// Reset cursor
		editor.dispatch({ selection: EditorSelection.cursor(0) });

		// Second heading: #heading-2
		expect(jumpToHash(editor, 'heading-2')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe('## Heading\n\nSome content\n\n## Heading'.length);

		// Reset cursor
		editor.dispatch({ selection: EditorSelection.cursor(0) });

		// Third heading: #heading-3
		expect(jumpToHash(editor, 'heading-3')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe(docText.length);
	});

	test('should handle mixed duplicate and unique headings', async () => {
		const docText = '## First\n\n## Heading\n\n## Second\n\n## Heading';
		const editor = await createTestEditor(
			docText,
			EditorSelection.cursor(0),
			['ATXHeading2'],
		);

		// Unique heading
		expect(jumpToHash(editor, 'first')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe('## First'.length);

		editor.dispatch({ selection: EditorSelection.cursor(0) });

		// First duplicate
		expect(jumpToHash(editor, 'heading')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe('## First\n\n## Heading'.length);

		editor.dispatch({ selection: EditorSelection.cursor(0) });

		// Second duplicate gets -2 suffix
		expect(jumpToHash(editor, 'heading-2')).toBe(true);
		expect(editor.state.selection.main.anchor).toBe(docText.length);
	});
});
