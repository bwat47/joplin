import { EditorSelection } from '@codemirror/state';
import createTestEditor from '../../testing/createTestEditor';
import renderTables, {
	cellTextCodec,
	tableDescriptorField,
	testing__resetTableDescriptorIds,
} from './renderTables';
import { blur, focus } from '@joplin/lib/utils/focusHandler';

const tableMarkdown = [
	'| A | B |',
	'| - | - |',
	'| 1 | 2 |',
].join('\n');

const createEditor = async (initialMarkdown = tableMarkdown) => {
	testing__resetTableDescriptorIds();
	return createTestEditor(
		initialMarkdown,
		EditorSelection.cursor(0),
		['TableHeader'],
		[renderTables],
	);
};

const waitForTimers = async () => {
	await new Promise(resolve => setTimeout(resolve, 220));
	await Promise.resolve();
};

describe('renderTables', () => {
	test('cellTextCodec converts between serialized table text and editable draft text', () => {
		expect(cellTextCodec.toDraft('a\\|b')).toBe('a|b');
		expect(cellTextCodec.toDraft('first<br>second')).toBe('first\nsecond');

		expect(cellTextCodec.toTableCellContent('a|b')).toBe('a\\|b');
		expect(cellTextCodec.toTableCellContent('first\nsecond')).toBe('first<br>second');
		expect(cellTextCodec.toTableCellContent(' padded ')).toBe(' padded ');
	});

	test('reuses a table descriptor across unrelated parent document changes', async () => {
		const editor = await createEditor(`${tableMarkdown}\n\nTail`);
		const descriptor = editor.state.field(tableDescriptorField)[0];

		editor.dispatch({
			changes: { from: editor.state.doc.length, insert: '\nMore text' },
		});

		expect(editor.state.field(tableDescriptorField)[0]).toBe(descriptor);
		expect(descriptor.from).toBe(0);
		expect(descriptor.sourceText).toBe(tableMarkdown);
	});

	test('drops descriptors when the table is deleted', async () => {
		const editor = await createEditor();

		editor.dispatch({
			changes: { from: 0, to: tableMarkdown.length, insert: 'No table here' },
		});

		expect(editor.state.field(tableDescriptorField)).toHaveLength(0);
	});

	test('flushes dirty cell edits to the parent document after focus leaves the table', async () => {
		const editor = await createEditor();
		const cell = editor.dom.querySelector<HTMLElement>('.cm-tw-text[data-row="1"][data-col="0"]');
		expect(cell).not.toBeNull();

		focus('renderTables.test', cell!);
		cell!.textContent = 'edited|cell';
		cell!.dispatchEvent(new InputEvent('input', { bubbles: true }));
		blur('renderTables.test', cell!);
		await waitForTimers();

		expect(editor.state.doc.toString()).toContain('edited\\|cell');
	});
});
