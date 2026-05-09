import { EditorSelection } from '@codemirror/state';
import createTestEditor from '../../testing/createTestEditor';
import renderTables, {
	cellTextCodec,
	tableEditAnnotation,
	tableDescriptorField,
	testing__getNestedCellEditorView,
	testing__resetTableDescriptorIds,
} from './renderTables';
import { blur } from '@joplin/lib/utils/focusHandler';
import { EditorView } from '@codemirror/view';

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

const replaceCellDraft = (cellMount: HTMLElement, text: string) => {
	cellMount.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
	const childEditor = testing__getNestedCellEditorView(cellMount);
	expect(childEditor).not.toBeNull();
	childEditor!.dispatch({
		changes: { from: 0, to: childEditor!.state.doc.length, insert: text },
	});
	return childEditor!;
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

		const childEditor = replaceCellDraft(cell!, 'edited|cell');
		expect(cell!.querySelector('.cm-editor')).not.toBeNull();
		expect(cell!.contentEditable).not.toBe('true');
		blur('renderTables.test', childEditor.contentDOM);
		await waitForTimers();

		expect(editor.state.doc.toString()).toContain('edited\\|cell');
	});

	test('table-owned edits update the parent document without remounting the table widget', async () => {
		const tableEditTransactions: boolean[] = [];
		const editor = await createTestEditor(
			tableMarkdown,
			EditorSelection.cursor(0),
			['TableHeader'],
			[
				renderTables,
				EditorView.updateListener.of(update => {
					for (const transaction of update.transactions) {
						if (transaction.annotation(tableEditAnnotation)) {
							tableEditTransactions.push(transaction.scrollIntoView);
						}
					}
				}),
			],
		);

		const descriptor = editor.state.field(tableDescriptorField)[0];
		const widgetDom = editor.dom.querySelector<HTMLElement>('.cm-tw');
		const cell = editor.dom.querySelector<HTMLElement>('.cm-tw-text[data-row="1"][data-col="0"]');
		expect(widgetDom).not.toBeNull();
		expect(cell).not.toBeNull();

		replaceCellDraft(cell!, 'edited table cell');
		await waitForTimers();

		expect(editor.state.doc.toString()).toContain('edited table cell');
		expect(editor.state.field(tableDescriptorField)[0]).toBe(descriptor);
		expect(editor.dom.querySelector<HTMLElement>('.cm-tw')).toBe(widgetDom);
		expect(tableEditTransactions).toEqual([false]);
	});

	test('right-clicking an active empty cell keeps the nested editor mounted', async () => {
		const editor = await createEditor();
		const cell = editor.dom.querySelector<HTMLElement>('.cm-tw-text[data-row="1"][data-col="0"]');
		expect(cell).not.toBeNull();

		const childEditor = replaceCellDraft(cell!, '');
		expect(testing__getNestedCellEditorView(cell!)).toBe(childEditor);

		const emptyCellElement = cell!.parentElement!;
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, button: 2, cancelable: true });
		emptyCellElement.dispatchEvent(mouseDown);
		emptyCellElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));

		expect(mouseDown.defaultPrevented).toBe(true);
		expect(testing__getNestedCellEditorView(cell!)).toBe(childEditor);
		expect(cell!.querySelector('.cm-editor')).not.toBeNull();
	});
});
