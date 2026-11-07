import { EditorSelection, Extension } from '@codemirror/state';
import createTestEditor from '../../../testing/createTestEditor';
import replaceBackslashEscapes from '../replaceBackslashEscapes';
import replaceBulletLists from '../replaceBulletLists';
import replaceFormatCharacters from '../replaceFormatCharacters';
import replaceInlineHtml from '../replaceInlineHtml';
import replaceLinks from '../replaceLinks';
import visibleEditorText from '../../../testing/visibleEditorText';
import backspaceOnce from '../../../testing/backspaceOnce';

jest.retryTimes(2);

interface TestCase {
	label: string;
	markdown: string;
	renderedText: string;
	selectionFrom: number;
	selectionTo: number;
	expectedSyntaxTreeTags: string[];
	extensions: Extension[];
}

const testCases: TestCase[] = [
	{
		label: 'bold text',
		markdown: '**bold**\n',
		renderedText: 'bold',
		selectionFrom: 2,
		selectionTo: 6,
		expectedSyntaxTreeTags: ['StrongEmphasis'],
		extensions: [replaceFormatCharacters],
	},
	{
		label: 'bold italic text',
		markdown: '***bold italic***\n',
		renderedText: 'bold italic',
		selectionFrom: 3,
		selectionTo: 14,
		expectedSyntaxTreeTags: ['Emphasis', 'StrongEmphasis'],
		extensions: [replaceFormatCharacters],
	},
	{
		label: 'heading',
		markdown: '# Heading\n',
		renderedText: 'Heading',
		selectionFrom: 2,
		selectionTo: 9,
		expectedSyntaxTreeTags: ['ATXHeading1'],
		extensions: [replaceFormatCharacters],
	},
	{
		label: 'blockquote',
		markdown: '> Blockquote\n',
		renderedText: ' Blockquote',
		selectionFrom: 2,
		selectionTo: 12,
		expectedSyntaxTreeTags: ['Blockquote'],
		extensions: [replaceFormatCharacters],
	},
	{
		label: 'link',
		markdown: '[Joplin website](https://joplinapp.org)\n',
		renderedText: 'Joplin website',
		selectionFrom: 1,
		selectionTo: 15,
		expectedSyntaxTreeTags: ['Link'],
		extensions: [replaceLinks],
	},
	{
		label: 'link with bold text',
		markdown: '[**Joplin website**](https://joplinapp.org)\n',
		renderedText: 'Joplin website',
		selectionFrom: 3,
		selectionTo: 17,
		expectedSyntaxTreeTags: ['Link', 'StrongEmphasis'],
		extensions: [replaceFormatCharacters, replaceLinks],
	},
	{
		label: 'inline HTML',
		markdown: '<span style="color: red">red text</span>\n',
		renderedText: 'red text',
		selectionFrom: 25,
		selectionTo: 33,
		expectedSyntaxTreeTags: ['HTMLTag'],
		extensions: [replaceInlineHtml],
	},
	{
		label: 'escaped asterisks',
		markdown: '\\*literal asterisk\\*\n',
		renderedText: '*literal asterisk*',
		selectionFrom: 1,
		selectionTo: 20,
		expectedSyntaxTreeTags: ['Escape'],
		extensions: [replaceBackslashEscapes],
	},
	{
		label: 'bullet list item',
		markdown: '- item\n',
		renderedText: '- item',
		selectionFrom: 2,
		selectionTo: 6,
		expectedSyntaxTreeTags: ['BulletList'],
		extensions: [replaceBulletLists],
	},
	{
		label: 'bullet list item with selected leading space',
		markdown: '- item\n',
		renderedText: '- item',
		selectionFrom: 1,
		selectionTo: 6,
		expectedSyntaxTreeTags: ['BulletList'],
		extensions: [replaceBulletLists],
	},
];

const directedTestCases = testCases.flatMap(testCase => [
	{
		...testCase,
		direction: 'forward',
		selection: EditorSelection.range(testCase.selectionFrom, testCase.selectionTo),
	},
	{
		...testCase,
		direction: 'backward',
		selection: EditorSelection.range(testCase.selectionTo, testCase.selectionFrom),
	},
]);

// Temporary CI diagnostic. Intermittently, `expect(textContent).toBe('red text')` fails with
// Expected: "red text" / Received: "red text" - visually identical but unequal, so the actual
// string differs by an invisible codepoint (e.g. char code 160/8203 where the healthy value has
// a normal space, 32). This logs the char codes on mismatch to identify it. Remove once diagnosed.
const expectTextContentToBe = (actual: string, expected: string) => {
	if (actual !== expected) {
		// eslint-disable-next-line no-console
		console.error('FLAKE_DIAGNOSTIC', JSON.stringify({
			expectedCodes: [...expected].map(character => character.charCodeAt(0)),
			actualCodes: [...actual].map(character => character.charCodeAt(0)),
		}));
	}
	expect(actual).toBe(expected);
};

describe('makeInlineReplaceExtension', () => {
	beforeAll(() => {
		jest.useFakeTimers({ advanceTimers: true });
	});

	it.each(directedTestCases)('should include Markdown syntax for $label in a $direction mouse selection', async ({
		markdown, renderedText, selection, expectedSyntaxTreeTags, extensions,
	}) => {
		const editor = await createTestEditor(
			markdown,
			EditorSelection.cursor(markdown.length),
			expectedSyntaxTreeTags,
			extensions,
		);

		try {
			editor.dom.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
			editor.dispatch({ selection, userEvent: 'select.pointer' });
			jest.runAllTimers();

			const expectedSelection = {
				anchor: selection.anchor,
				head: selection.head,
			};
			expect(editor.state.selection.main).toMatchObject(expectedSelection);
			expectTextContentToBe(visibleEditorText(editor), renderedText);

			editor.dom.ownerDocument.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
			await jest.runAllTimersAsync();

			expect(editor.state.selection.main).toMatchObject(expectedSelection);
			expectTextContentToBe(visibleEditorText(editor), markdown.trimEnd());
		} finally {
			editor.destroy();
		}
	});

	it.each([
		{ label: 'closing bold mark', markdown: 'This is **bold** text', from: 0, to: 14, expectedFrom: 0, expectedTo: 16, tags: ['StrongEmphasis'] },
		{ label: 'opening bold mark', markdown: 'This is **bold** text', from: 10, to: 21, expectedFrom: 8, expectedTo: 21, tags: ['StrongEmphasis'] },
		{ label: 'bold at the start of a line', markdown: '**bold** text', from: 0, to: 6, expectedFrom: 0, expectedTo: 8, tags: ['StrongEmphasis'] },
		{ label: 'bold at the end of a line', markdown: 'This is **bold**', from: 10, to: 16, expectedFrom: 8, expectedTo: 16, tags: ['StrongEmphasis'] },
		{ label: 'nested marks', markdown: 'This ***bold italic*** text', from: 0, to: 19, expectedFrom: 0, expectedTo: 22, tags: ['Emphasis', 'StrongEmphasis'] },
		{ label: 'heading mark from the next line', markdown: 'Text\n## Heading\nMore text', from: 8, to: 20, expectedFrom: 5, expectedTo: 20, tags: ['ATXHeading2'] },
		{ label: 'link destination', markdown: 'See [Joplin](https://joplinapp.org)', from: 0, to: 11, expectedFrom: 0, expectedTo: 35, tags: ['Link'] },
		{ label: 'closing HTML tag', markdown: 'If you <sup>create</sup> a file', from: 0, to: 18, expectedFrom: 0, expectedTo: 24, tags: ['HTMLTag'] },
		{ label: 'opening HTML tag', markdown: 'If you <sup>create</sup> a file', from: 12, to: 31, expectedFrom: 7, expectedTo: 31, tags: ['HTMLTag'] },
		{ label: 'only the bold content', markdown: 'This is **bold** text', from: 10, to: 14, expectedFrom: 10, expectedTo: 14, tags: ['StrongEmphasis'] },
		{ label: 'only the HTML content', markdown: 'If you <sup>create</sup> a file', from: 12, to: 18, expectedFrom: 12, expectedTo: 18, tags: ['HTMLTag'] },
		{ label: 'only the heading content', markdown: '## Heading', from: 3, to: 10, expectedFrom: 3, expectedTo: 10, tags: ['ATXHeading2'] },
	])('should expand a mouse selection to include the $label', async ({ markdown, from, to, expectedFrom, expectedTo, tags }) => {
		const editor = await createTestEditor(
			markdown,
			EditorSelection.cursor(markdown.length),
			tags,
			[replaceFormatCharacters, replaceLinks, replaceInlineHtml],
		);

		try {
			for (const [anchor, head, expectedAnchor, expectedHead] of [[from, to, expectedFrom, expectedTo], [to, from, expectedTo, expectedFrom]]) {
				editor.dispatch({ selection: EditorSelection.cursor(markdown.length) });
				editor.dom.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
				editor.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: 'select.pointer' });
				editor.dom.ownerDocument.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
				await jest.runAllTimersAsync();

				expect(editor.state.selection.main).toMatchObject({ anchor: expectedAnchor, head: expectedHead });
			}
		} finally {
			editor.destroy();
		}
	});

	it('should not expand a selection made with the keyboard', async () => {
		const markdown = 'This is **bold** text';
		const editor = await createTestEditor(markdown, EditorSelection.cursor(markdown.length), ['StrongEmphasis'], [replaceFormatCharacters]);

		try {
			editor.dispatch({ selection: EditorSelection.range(0, 14), userEvent: 'select' });
			expect(editor.state.selection.main).toMatchObject({ anchor: 0, head: 14 });
		} finally {
			editor.destroy();
		}
	});

	it('should update markdown decorations when the mouse is down and the document changes', async () => {
		const markdown = '**test**...';
		const initialSelection = EditorSelection.cursor(markdown.length);
		const editor = await createTestEditor(
			'**test**...',
			initialSelection,
			['StrongEmphasis'],
			[replaceFormatCharacters],
		);

		try {
			editor.dom.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
			editor.dispatch({ selection: initialSelection, userEvent: 'select.pointer' });
			jest.runAllTimers();

			expectTextContentToBe(visibleEditorText(editor), 'test...');

			backspaceOnce(editor);
			expectTextContentToBe(visibleEditorText(editor), 'test..');
			backspaceOnce(editor);
			expectTextContentToBe(visibleEditorText(editor), 'test.');
			backspaceOnce(editor);
			expectTextContentToBe(visibleEditorText(editor), '**test**');

			editor.dom.ownerDocument.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
			await jest.runAllTimersAsync();

			expectTextContentToBe(visibleEditorText(editor), '**test**');
		} finally {
			editor.destroy();
		}
	});
});
