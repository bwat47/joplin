import { EditorSelection } from '@codemirror/state';
import waitFor from '@joplin/lib/testing/waitFor';
import { InlineMarkupRenderMode } from '../../../types';
import createTestEditor from '../../testing/createTestEditor';
import replaceFormatCharacters from './replaceFormatCharacters';

const createEditor = async (initialMarkdown: string, cursorIndex: number, mode: InlineMarkupRenderMode) => {
	return createTestEditor(
		initialMarkdown,
		EditorSelection.cursor(cursorIndex),
		['EmphasisMark'],
		[replaceFormatCharacters(mode)],
	);
};

describe('replaceFormatCharacters', () => {
	test('normal mode should only reveal active format markers', async () => {
		const markdown = 'A *one* B *two*';
		const editor = await createEditor(markdown, markdown.indexOf('one') + 1, InlineMarkupRenderMode.Normal);

		await waitFor(() => {
			expect(editor.contentDOM.textContent).toContain('*one*');
			expect(editor.contentDOM.textContent).not.toContain('*two*');
		});
	});

	test('accessible mode should reveal all format markers on the active line', async () => {
		const markdown = 'A *one* B *two*';
		const editor = await createEditor(markdown, markdown.indexOf('one') + 1, InlineMarkupRenderMode.Accessible);

		await waitFor(() => {
			expect(editor.contentDOM.textContent).toContain('*one*');
			expect(editor.contentDOM.textContent).toContain('*two*');
		});
	});
});
