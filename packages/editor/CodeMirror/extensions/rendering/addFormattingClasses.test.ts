import { EditorSelection } from '@codemirror/state';
import waitFor from '@joplin/lib/testing/waitFor';
import { InlineMarkupRenderMode } from '../../../types';
import createTestEditor from '../../testing/createTestEditor';
import addFormattingClasses from './addFormattingClasses';

const className = 'cm-ext-unfocused-link';

const createEditor = async (initialMarkdown: string, cursorIndex: number, mode: InlineMarkupRenderMode) => {
	return createTestEditor(
		initialMarkdown,
		EditorSelection.cursor(cursorIndex),
		['Link', 'URL'],
		[addFormattingClasses(mode)],
	);
};

describe('addFormattingClasses', () => {
	test('normal mode should keep styling for non-active formatting on the line', async () => {
		const markdown = '[one](https://example.com/1) and [two](https://example.com/2)';
		const editor = await createEditor(markdown, markdown.indexOf('one') + 1, InlineMarkupRenderMode.Normal);

		await waitFor(() => {
			expect(editor.contentDOM.querySelectorAll(`.${className}`).length).toBeGreaterThan(0);
		});
	});

	test('accessible mode should remove styling on the active line', async () => {
		const markdown = '[one](https://example.com/1) and [two](https://example.com/2)';
		const editor = await createEditor(markdown, markdown.indexOf('one') + 1, InlineMarkupRenderMode.Accessible);

		await waitFor(() => {
			expect(editor.contentDOM.querySelectorAll(`.${className}`)).toHaveLength(0);
		});
	});
});
