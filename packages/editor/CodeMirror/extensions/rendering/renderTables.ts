// Joplin-native interactive table editor widget for CodeMirror 6.
// Clean design: no grip columns, table stays flush-left.
// - Hover near row/column edges → "+" button appears via absolute positioning
// - Right-click any cell → context menu for insert/move/delete
// - Enter in last cell → adds new row
// - Tab/Shift+Tab → navigate cells

import { EditorView, WidgetType, Decoration, ViewPlugin, ViewUpdate, drawSelection, keymap } from '@codemirror/view';
import { Annotation, Compartment, EditorState, Extension, Range, StateField, Transaction } from '@codemirror/state';
import { indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { defaultKeymap } from '@codemirror/commands';
import { classHighlighter } from '@lezer/highlight';
import { GFM as GitHubFlavoredMarkdownExtension } from '@lezer/markdown';
import { focus, blur } from '@joplin/lib/utils/focusHandler';
import markdownMathExtension from '../markdownMathExtension';
import markdownHighlightExtension, { markdownInsertExtension } from '../markdownHighlightExtension';
import { editorSettingsFacet } from '../editorSettingsExtension';
import decoratorExtension from '../markdownDecorationExtension';
import lookUpLanguage from '../../utils/markdown/codeBlockLanguages/lookUpLanguage';
import {
	parseTable, serializeTable,
	addRow, addColumn, deleteRow, deleteColumn,
	swapRows, swapColumns,
	Table,
} from '../../utils/markdown/tableUtils';
import { getCellContentPosition } from '../../editorCommands/tableCommands';
import createTheme from '../../theme';
import { EditorSettings } from '../../../types';

// Short class name prefix
const W = 'cm-tw';
const CELL = 'cm-tw-c';
const HDR = 'cm-tw-h';
const CTX = 'cm-tw-ctx';

// Cache for rendered table widget heights so CodeMirror can estimate
// heights correctly for scroll position and coordinate mapping.
const tableHeightCache = new Map<string, number>();
const tableSessionByContainer = new WeakMap<HTMLElement, TableWidgetSession>();
const testingNestedEditorByMount = new WeakMap<HTMLElement, EditorView>();

type CellCoord = { row: number; col: number };
type CellSelection = { anchor: number; head: number };
type ContextMenuHandler = (event: MouseEvent, coord: CellCoord)=> void;

type ActiveCellEditorBridge = {
	onDraftChanged: (cell: CellView, draftText: string)=> void;
	onSelectionChanged: (cell: CellView, selection: CellSelection)=> void;
	onCommitRequested: (cell: CellView)=> void;
	onFocus: (cell: CellView)=> void;
	onGeometryChanged: (cell: CellView)=> void;
};

type ActiveCellEditorSurface = {
	mount: ()=> void;
	unmount: ()=> void;
	focusEditor: (selection?: CellSelection | null)=> void;
	blurEditor: ()=> void;
	getDraftText: ()=> string;
	getSelection: ()=> CellSelection | null;
	setSelection: (selection: CellSelection)=> void;
	setDraftText: (draftText: string)=> void;
	updateEditorSettings: (settings: EditorSettings | null)=> void;
	dispose: ()=> void;
};

export interface TableDescriptor {
	id: string;
	from: number;
	to: number;
	sourceText: string;
	lastDispatchedText: string;
	table: Table;
	activeCell: CellCoord | null;
	activeSelection: CellSelection | null;
	pendingFocus: CellCoord | null;
	scrollLeft: number;
	contentVersion: number;
	structureVersion: number;
	renderVersion: number;
	dirty: boolean;
	dispatchScheduled: boolean;
}

export const tableEditAnnotation = Annotation.define<{ descriptorId: string }>();

export const cellTextCodec = {
	toDraft: (tableCellContent: string): string => {
		return tableCellContent.replace(/<br\s*\/?>/gi, '\n').replace(/\\\|/g, '|');
	},

	toTableCellContent: (draft: string): string => {
		return draft.replace(/\n/g, '<br>').replace(/\|/g, '\\|');
	},
};

const eventTargetElement = (target: EventTarget | null): Element | null => {
	if (!target) return null;
	const maybeElement = target as Element;
	if (typeof maybeElement.closest === 'function') return maybeElement;
	return (target as Node & { parentElement?: Element | null }).parentElement ?? null;
};

const selectionFromEditorState = (state: EditorState): CellSelection => ({
	anchor: state.selection.main.anchor,
	head: state.selection.main.head,
});

const nestedCellEditorLayoutTheme = EditorView.theme({
	'&.cm-editor': {
		background: 'transparent',
		height: '100%',
		minHeight: '1.2em',
		outline: 'none',
	},
	'&.cm-focused': {
		outline: 'none',
	},
	'& .cm-scroller': {
		fontFamily: 'inherit',
		lineHeight: 'inherit',
		overflow: 'visible',
	},
	'&.cm-editor .cm-content': {
		boxSizing: 'border-box',
		lineHeight: 'inherit',
		marginLeft: '0',
		marginRight: '0',
		maxWidth: 'none',
		minHeight: '1.2em',
		padding: '0',
		paddingBottom: '0',
		whiteSpace: 'pre-wrap',
	},
	'& .cm-line': {
		padding: '0',
	},
});

const createNestedCellEditorLanguageExtension = (settings: EditorSettings | null): Extension => {
	const markdownMarkEnabled = settings?.markdownMarkEnabled ?? true;
	const markdownInsertEnabled = settings?.markdownInsertEnabled ?? true;
	const katexEnabled = settings?.katexEnabled ?? true;
	const autocompleteMarkup = settings?.autocompleteMarkup ?? true;

	return markdown({
		extensions: [
			GitHubFlavoredMarkdownExtension,
			markdownMarkEnabled ? markdownHighlightExtension : [],
			markdownInsertEnabled ? markdownInsertExtension : [],
			katexEnabled ? markdownMathExtension : [],
		],
		codeLanguages: lookUpLanguage,
		addKeymap: false,
		...(autocompleteMarkup ? {} : {
			completeHTMLTags: false,
			htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false }),
		}),
	});
};

const createNestedCellEditorSettingsExtensions = (settings: EditorSettings | null): Extension[] => [
	createNestedCellEditorLanguageExtension(settings),
	settings ? createTheme(settings.themeData) : [],
	indentUnit.of(settings?.indentWithTabs ? '\t' : '    '),
	EditorView.contentAttributes.of({
		autocapitalize: 'sentence',
		autocorrect: settings?.spellcheckEnabled ? 'true' : 'false',
		spellcheck: settings?.spellcheckEnabled ? 'true' : 'false',
		'aria-label': settings?.editorLabel ?? 'Table cell editor',
	}),
	nestedCellEditorLayoutTheme,
];

const createNestedCellEditorExtensions = (
	cell: CellView,
	bridge: ActiveCellEditorBridge,
	editorSettings: Compartment,
	settings: EditorSettings | null,
): Extension[] => [
	editorSettings.of(createNestedCellEditorSettingsExtensions(settings)),
	drawSelection(),
	decoratorExtension,
	syntaxHighlighting(classHighlighter),
	EditorView.lineWrapping,
	EditorView.domEventHandlers({
		focus: () => {
			bridge.onFocus(cell);
			return false;
		},
		blur: () => {
			bridge.onCommitRequested(cell);
			return false;
		},
		keydown: (event, childView) => {
			if (event.key === 'Enter' && event.shiftKey) {
				event.preventDefault();
				childView.dispatch(childView.state.replaceSelection('\n'));
				return true;
			}
			cell.handleKeyDown(event);
			return event.defaultPrevented;
		},
	}),
	keymap.of(defaultKeymap),
	EditorView.updateListener.of((update: ViewUpdate) => {
		if (update.docChanged) {
			bridge.onDraftChanged(cell, update.state.doc.toString());
			bridge.onGeometryChanged(cell);
		}
		if (update.selectionSet || update.docChanged) {
			bridge.onSelectionChanged(cell, selectionFromEditorState(update.state));
		}
	}),
];

let nextTableDescriptorId = 1;

const makeTableDescriptor = (from: number, to: number, sourceText: string, table: Table): TableDescriptor => ({
	id: `cm-table-${nextTableDescriptorId++}`,
	from,
	to,
	sourceText,
	lastDispatchedText: sourceText,
	table,
	activeCell: null,
	activeSelection: null,
	pendingFocus: null,
	scrollLeft: 0,
	contentVersion: 0,
	structureVersion: 0,
	renderVersion: 0,
	dirty: false,
	dispatchScheduled: false,
});

const cloneTable = (table: Table): Table => ({
	header: { cells: table.header.cells.map(cell => ({ ...cell })) },
	alignments: [...table.alignments],
	body: table.body.map(row => ({ cells: row.cells.map(cell => ({ ...cell })) })),
});

const descriptorSerializedText = (descriptor: TableDescriptor) => serializeTable(descriptor.table);

const tableTextWithFollowingSeparator = (view: EditorView, descriptor: TableDescriptor, tableText: string) => {
	const afterTable = descriptor.to < view.state.doc.length ? view.state.doc.sliceString(descriptor.to, Math.min(descriptor.to + 2, view.state.doc.length)) : '';
	const needsBlankLine = !afterTable.startsWith('\n\n');
	return needsBlankLine ? `${tableText}\n` : tableText;
};

const selectionWithinDescriptor = (state: EditorState, descriptor: TableDescriptor) => {
	return state.selection.ranges.every(range => range.from >= descriptor.from && range.to <= descriptor.to);
};

const clampSelection = (selection: CellSelection, documentLength: number): CellSelection => ({
	anchor: Math.max(0, Math.min(selection.anchor, documentLength)),
	head: Math.max(0, Math.min(selection.head, documentLength)),
});

const findTableSpans = (state: EditorState) => {
	const spans: { from: number; to: number; text: string; table: Table }[] = [];
	const seen = new Set<number>();
	syntaxTree(state).iterate({
		enter: node => {
			if (node.name !== 'TableHeader') return;
			const startLine = state.doc.lineAt(node.from);
			if (seen.has(startLine.from)) return;
			let endLine = startLine;
			for (let n = startLine.number + 1; n <= state.doc.lines; n++) {
				const line = state.doc.line(n);
				if (line.text.trim().startsWith('|') || line.text.includes('|')) {
					endLine = line;
				} else {
					break;
				}
			}

			const text = state.doc.sliceString(startLine.from, endLine.to);
			const table = parseTable(text);
			if (!table) return;

			seen.add(startLine.from);
			spans.push({ from: startLine.from, to: endLine.to, text, table });
		},
	});
	return spans;
};

const updateTableDecorations = (descriptors: readonly TableDescriptor[]) => {
	const widgets: Range<Decoration>[] = [];
	for (const descriptor of descriptors) {
		widgets.push(Decoration.replace({
			widget: new TableWidget(descriptor),
			block: true,
		}).range(descriptor.from, descriptor.to));
	}
	return Decoration.set(widgets, true);
};

const reconcileTableDescriptors = (
	state: EditorState,
	previous: readonly TableDescriptor[],
	transaction?: Transaction,
) => {
	const tableEdit = transaction?.annotation(tableEditAnnotation);
	const mappedPrevious = previous.map(descriptor => ({
		descriptor,
		from: transaction ? transaction.changes.mapPos(descriptor.from, 1) : descriptor.from,
		to: transaction ? transaction.changes.mapPos(descriptor.to, -1) : descriptor.to,
		used: false,
	}));

	const descriptors: TableDescriptor[] = [];
	for (const span of findTableSpans(state)) {
		let match = mappedPrevious.find(candidate => !candidate.used
			&& candidate.from === span.from
			&& candidate.to === span.to);
		if (!match && tableEdit) {
			match = mappedPrevious.find(candidate => !candidate.used
				&& candidate.descriptor.id === tableEdit.descriptorId);
		}
		const descriptor = match?.descriptor ?? makeTableDescriptor(span.from, span.to, span.text, span.table);
		if (match) match.used = true;

		descriptor.from = span.from;
		descriptor.to = span.to;
		descriptor.sourceText = span.text;

		const isTableOwnedEdit = tableEdit?.descriptorId === descriptor.id;

		if (isTableOwnedEdit) {
			descriptor.dirty = false;
			descriptor.dispatchScheduled = false;
			descriptor.lastDispatchedText = span.text;
		} else if (descriptor.dirty) {
			if (span.text === descriptorSerializedText(descriptor) || span.text === descriptor.lastDispatchedText) {
				descriptor.dirty = false;
				descriptor.dispatchScheduled = false;
				descriptor.lastDispatchedText = span.text;
			}
		} else if (span.text !== descriptor.lastDispatchedText) {
			descriptor.table = cloneTable(span.table);
			descriptor.lastDispatchedText = span.text;
			descriptor.contentVersion++;
			descriptor.renderVersion++;
			if (descriptor.activeCell) {
				descriptor.pendingFocus = descriptor.activeCell;
			}
		}

		descriptors.push(descriptor);
	}
	return descriptors;
};

export const testing__resetTableDescriptorIds = () => {
	nextTableDescriptorId = 1;
};

export const testing__getNestedCellEditorView = (mount: HTMLElement) => {
	return testingNestedEditorByMount.get(mount) ?? null;
};

export const tableDescriptorField = StateField.define<readonly TableDescriptor[]>({
	create: state => reconcileTableDescriptors(state, []),
	update: (descriptors, transaction) => {
		const selectionChanged = !transaction.newSelection.eq(transaction.startState.selection);
		const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
		if (transaction.docChanged || selectionChanged || treeChanged) {
			return reconcileTableDescriptors(transaction.state, descriptors, transaction);
		}
		return descriptors;
	},
	provide: field => EditorView.decorations.compute([field], state => updateTableDecorations(state.field(field))),
});

class TableEditingController {
	private sessionsByDescriptorId = new Map<string, TableWidgetSession>();
	private editorSettings: EditorSettings | null = null;

	public constructor(private view: EditorView) {}

	public update(update: ViewUpdate) {
		const previousSettings = update.startState.facet(editorSettingsFacet);
		const currentSettings = update.state.facet(editorSettingsFacet);
		if (previousSettings !== currentSettings) {
			this.editorSettings = currentSettings;
			for (const session of this.sessionsByDescriptorId.values()) {
				session.updateEditorSettings(currentSettings);
			}
		}

		if (update.docChanged || update.viewportChanged) {
			this.restorePendingFocus();
		}
	}

	public destroy() {
		for (const descriptor of this.view.state.field(tableDescriptorField, false) ?? []) {
			this.flushDescriptor(descriptor);
		}
		for (const session of this.sessionsByDescriptorId.values()) {
			session.dispose();
		}
		this.sessionsByDescriptorId.clear();
	}

	public getEditorSettings() {
		this.editorSettings ??= this.view.state.facet(editorSettingsFacet);
		return this.editorSettings;
	}

	public registerSession(descriptor: TableDescriptor, session: TableWidgetSession) {
		this.sessionsByDescriptorId.set(descriptor.id, session);
	}

	public unregisterSession(descriptor: TableDescriptor, session: TableWidgetSession) {
		if (this.sessionsByDescriptorId.get(descriptor.id) === session) {
			this.sessionsByDescriptorId.delete(descriptor.id);
		}
	}

	public markCellActive(descriptor: TableDescriptor, row: number, col: number) {
		descriptor.activeCell = { row, col };
		const tableRange = { from: descriptor.from, to: descriptor.to, text: descriptor.sourceText };
		const cellPos = getCellContentPosition(this.view.state, tableRange, row, col);
		if (cellPos !== null) {
			this.view.dispatch({ selection: { anchor: cellPos, head: cellPos } });
		}
	}

	public updateCellSelection(descriptor: TableDescriptor, coord: CellCoord, selection: CellSelection) {
		descriptor.activeCell = coord;
		descriptor.activeSelection = selection;
	}

	public updateCell(descriptor: TableDescriptor, coord: CellCoord, draftText: string) {
		const content = cellTextCodec.toTableCellContent(draftText);
		const cell = coord.row === 0
			? descriptor.table.header.cells[coord.col]
			: descriptor.table.body[coord.row - 1]?.cells[coord.col];
		if (!cell || cell.content === content) return;
		cell.content = content;
		descriptor.contentVersion++;
		this.markDirty(descriptor);
	}

	public updateAllCellsFromDOM(descriptor: TableDescriptor, container: HTMLElement) {
		const session = this.sessionsByDescriptorId.get(descriptor.id);
		if (session) {
			session.syncDirtyCells();
			return;
		}

		for (const textDiv of Array.from(container.querySelectorAll<HTMLElement>('.cm-tw-text'))) {
			const row = Number(textDiv.dataset.row);
			const col = Number(textDiv.dataset.col);
			if (Number.isNaN(row) || Number.isNaN(col)) continue;
			this.updateCell(descriptor, { row, col }, textDiv.textContent ?? '');
		}
	}

	public mutateTable(descriptor: TableDescriptor, table: Table | null, pendingFocus: CellCoord | null = null) {
		if (!table) return;
		descriptor.table = table;
		descriptor.structureVersion++;
		descriptor.contentVersion++;
		descriptor.renderVersion++;
		descriptor.pendingFocus = pendingFocus;
		descriptor.activeCell = pendingFocus;
		this.markDirty(descriptor);
		this.flushDescriptor(descriptor);
	}

	public deleteTable(descriptor: TableDescriptor) {
		this.view.dispatch({ changes: { from: descriptor.from, to: descriptor.to, insert: '' } });
	}

	public flushDescriptor(descriptor: TableDescriptor) {
		if (!descriptor.dirty) return;
		const tableText = descriptorSerializedText(descriptor);
		if (tableText === descriptor.lastDispatchedText) {
			descriptor.dirty = false;
			descriptor.dispatchScheduled = false;
			return;
		}

		descriptor.dispatchScheduled = false;
		descriptor.lastDispatchedText = tableText;
		const keepTableFocus = selectionWithinDescriptor(this.view.state, descriptor);
		if (keepTableFocus) descriptor.pendingFocus ??= descriptor.activeCell;

		this.view.dispatch({
			changes: {
				from: descriptor.from,
				to: descriptor.to,
				insert: tableTextWithFollowingSeparator(this.view, descriptor, tableText),
			},
			...(keepTableFocus ? { selection: { anchor: descriptor.from, head: descriptor.from } } : {}),
			annotations: tableEditAnnotation.of({ descriptorId: descriptor.id }),
		});
	}

	private markDirty(descriptor: TableDescriptor) {
		descriptor.dirty = descriptorSerializedText(descriptor) !== descriptor.lastDispatchedText;
		if (!descriptor.dirty || descriptor.dispatchScheduled) return;

		descriptor.dispatchScheduled = true;
		const win = this.view.dom.ownerDocument.defaultView ?? window;
		win.setTimeout(() => this.flushDescriptor(descriptor), 100);
	}

	private restorePendingFocus() {
		for (const descriptor of this.view.state.field(tableDescriptorField, false) ?? []) {
			if (!descriptor.pendingFocus) continue;
			const coord = descriptor.pendingFocus;
			descriptor.pendingFocus = null;
			requestAnimationFrame(() => {
				const container = this.findContainer(descriptor);
				if (!container) return;
				if (descriptor.scrollLeft > 0) container.scrollLeft = descriptor.scrollLeft;
				const session = this.sessionsByDescriptorId.get(descriptor.id);
				if (session) {
					session.focusCell(coord.row, coord.col, descriptor.activeSelection);
				} else {
					const target = container.querySelector<HTMLElement>(`.cm-tw-text[data-row="${coord.row}"][data-col="${coord.col}"]`);
					if (target) focus('TableWidget', target);
				}
			});
		}
	}

	private findContainer(descriptor: TableDescriptor): HTMLElement | null {
		return this.view.dom.querySelector<HTMLElement>(`.${W}[data-table-id="${descriptor.id}"]`);
	}
}

const tableEditingPlugin = ViewPlugin.fromClass(TableEditingController);

class CodeMirrorActiveCellEditor implements ActiveCellEditorSurface {
	private mounted = false;
	private editor: EditorView | null = null;
	private readonly editorSettingsCompartment = new Compartment();
	private draftText: string;

	public constructor(
		private cell: CellView,
		initialDraftText: string,
		private bridge: ActiveCellEditorBridge,
		private editorSettings: EditorSettings | null,
	) {
		this.draftText = initialDraftText;
		this.cell.textElement.textContent = initialDraftText;
	}

	public mount() {
		if (this.mounted) return;
		this.mounted = true;

		if (!this.editor) {
			this.cell.textElement.textContent = '';
			this.editor = new EditorView({
				state: EditorState.create({
					doc: this.draftText,
					extensions: createNestedCellEditorExtensions(this.cell, this.bridge, this.editorSettingsCompartment, this.editorSettings),
				}),
				parent: this.cell.textElement,
			});
			testingNestedEditorByMount.set(this.cell.textElement, this.editor);
		}
	}

	public unmount() {
		if (!this.mounted) return;
		this.mounted = false;
		this.draftText = this.getDraftText();
		this.editor?.destroy();
		this.editor = null;
		testingNestedEditorByMount.delete(this.cell.textElement);
		this.cell.textElement.textContent = this.draftText;
	}

	public focusEditor(selection: CellSelection | null = null) {
		this.mount();
		if (selection) this.setSelection(selection);
		if (this.editor) focus('TableWidget', this.editor.contentDOM);
	}

	public blurEditor() {
		if (this.editor) blur('TableWidget', this.editor.contentDOM);
	}

	public getDraftText() {
		this.draftText = this.editor?.state.doc.toString() ?? this.draftText;
		return this.draftText;
	}

	public getSelection() {
		return this.editor ? selectionFromEditorState(this.editor.state) : null;
	}

	public setSelection(selection: CellSelection) {
		if (!this.editor) return;
		const clampedSelection = clampSelection(selection, this.editor.state.doc.length);
		this.editor.dispatch({ selection: clampedSelection });
	}

	public setDraftText(draftText: string) {
		this.draftText = draftText;
		if (this.editor) {
			this.editor.dispatch({
				changes: { from: 0, to: this.editor.state.doc.length, insert: draftText },
			});
		} else {
			this.cell.textElement.textContent = draftText;
		}
	}

	public updateEditorSettings(settings: EditorSettings | null) {
		this.editorSettings = settings;
		this.editor?.dispatch({
			effects: this.editorSettingsCompartment.reconfigure(createNestedCellEditorSettingsExtensions(settings)),
		});
	}

	public dispose() {
		this.unmount();
		this.editor?.destroy();
		this.editor = null;
		testingNestedEditorByMount.delete(this.cell.textElement);
	}
}

class CellView {
	public readonly cellElement: HTMLElement;
	public readonly textElement: HTMLElement;
	public readonly editorSurface: ActiveCellEditorSurface;
	private blurTimeout: ReturnType<typeof setTimeout> | null = null;

	public constructor(
		private doc: Document,
		public readonly coordinates: CellCoord,
		text: string,
		isHeader: boolean,
		private session: TableWidgetSession,
		private showContextMenu: ContextMenuHandler,
	) {
		this.cellElement = this.createCellElement(isHeader);
		this.textElement = this.createTextElement();
		this.editorSurface = new CodeMirrorActiveCellEditor(
			this,
			cellTextCodec.toDraft(text),
			{
				onDraftChanged: (cell, draftText) => session.handleCellDraftChanged(cell, draftText),
				onSelectionChanged: (cell, selection) => session.handleCellSelectionChanged(cell, selection),
				onCommitRequested: cell => session.handleCellBlur(cell),
				onFocus: cell => session.handleCellFocus(cell),
				onGeometryChanged: cell => session.handleCellGeometryChanged(cell),
			},
			session.getEditorSettings(),
		);
		this.textElement.dataset.row = `${coordinates.row}`;
		this.textElement.dataset.col = `${coordinates.col}`;
		this.cellElement.appendChild(this.textElement);
	}

	public dispose() {
		if (this.blurTimeout !== null) {
			clearTimeout(this.blurTimeout);
			this.blurTimeout = null;
		}
		this.editorSurface.dispose();
		this.cellElement.onmousedown = null;
		this.cellElement.oncontextmenu = null;
	}

	public handleKeyDown(event: KeyboardEvent) {
		this.session.handleCellKeyDown(event, this);
	}

	public setBlurTimeout(timeout: ReturnType<typeof setTimeout>) {
		this.blurTimeout = timeout;
	}

	private createCellElement(isHeader: boolean) {
		const element = this.doc.createElement(isHeader ? 'th' : 'td');
		element.classList.add(CELL);
		if (isHeader) element.classList.add(HDR);
		element.onmousedown = event => {
			if (event.button === 2) {
				event.preventDefault();
				return;
			}
			if (event.button !== 0) return;
			const targetElement = eventTargetElement(event.target);
			const targetNode = event.target as Node | null;
			const nestedEditorElement = this.textElement.querySelector('.cm-editor');
			if (targetNode && nestedEditorElement?.contains(targetNode)) return;
			if (targetElement?.closest('.cm-tw-ac-wrap, .cm-tw-ar-wrap, .cm-tw-ctx')) return;

			event.preventDefault();
			this.editorSurface.focusEditor();
		};
		element.oncontextmenu = event => this.showContextMenu(event, this.coordinates);
		return element;
	}

	private createTextElement() {
		const textElement = this.doc.createElement('div');
		textElement.classList.add('cm-tw-text');
		return textElement;
	}
}

class TableWidgetSession {
	private allCells: CellView[][] = [];
	private lastFocusedCell: CellView | null = null;
	private skipBlurSync = false;
	private scrollbarDragging = false;
	private remeasurePending = false;
	private editorSettings: EditorSettings | null;

	public constructor(
		private view: EditorView,
		private descriptor: TableDescriptor,
		private container: HTMLElement,
		private tableElement: HTMLElement,
		private doc: Document,
		private controller: TableEditingController | null,
		private remeasureHandler: ()=> void,
		private applyTableChangeHandler: (newTable: Table | null, pendingFocus?: CellCoord | null)=> void,
	) {
		this.editorSettings = controller?.getEditorSettings() ?? view.state.facet(editorSettingsFacet);
	}

	public registerCell(cell: CellView) {
		const { row, col } = cell.coordinates;
		this.allCells[row] ??= [];
		this.allCells[row][col] = cell;
	}

	public getEditorSettings() {
		return this.editorSettings;
	}

	public updateEditorSettings(settings: EditorSettings | null) {
		if (this.editorSettings === settings) return;
		this.editorSettings = settings;
		for (const cell of this.getFlatCells()) {
			cell.editorSurface.updateEditorSettings(settings);
		}
	}

	public getCell(row: number, col: number) {
		return this.allCells[row]?.[col] ?? null;
	}

	public getFlatCells() {
		return this.allCells.flat().filter((cell): cell is CellView => !!cell);
	}

	public focusCell(row: number, col: number, selection: CellSelection | null = null) {
		this.getCell(row, col)?.editorSurface.focusEditor(selection);
	}

	public handleCellFocus(cell: CellView) {
		this.lastFocusedCell = cell;
		this.controller?.markCellActive(this.descriptor, cell.coordinates.row, cell.coordinates.col);
	}

	public handleCellDraftChanged(cell: CellView, draftText: string) {
		this.controller?.updateCell(this.descriptor, cell.coordinates, draftText);
	}

	public handleCellSelectionChanged(cell: CellView, selection: CellSelection) {
		this.controller?.updateCellSelection(this.descriptor, cell.coordinates, selection);
	}

	public handleCellGeometryChanged(_cell: CellView) {
		if (this.remeasurePending) return;
		this.remeasurePending = true;
		requestAnimationFrame(() => {
			this.remeasurePending = false;
			if (!this.container.isConnected) return;
			this.remeasureHandler();
			this.view.requestMeasure();
		});
	}

	public handleCellBlur(cell: CellView) {
		if (this.consumeSkipBlurSync()) return;
		cell.setBlurTimeout(setTimeout(() => {
			if (!this.container.isConnected) return;
			this.commitCellDraft(cell);
			if (this.scrollbarDragging || this.container.contains(this.doc.activeElement)) return;
			cell.editorSurface.unmount();
			this.descriptor.activeCell = null;
			this.syncDirtyCells();
			this.controller?.flushDescriptor(this.descriptor);
		}, 80));
	}

	public handleCellKeyDown(event: KeyboardEvent, cell: CellView) {
		const { row, col } = cell.coordinates;
		if (event.key === 'Tab') {
			event.preventDefault();
			event.stopPropagation();
			this.markSkipBlurSync();
			this.syncDirtyCells();

			const flat = this.getFlatCells();
			const currentIndex = flat.indexOf(cell);
			const nextIndex = event.shiftKey ? currentIndex - 1 : currentIndex + 1;

			if (nextIndex >= 0 && nextIndex < flat.length) {
				flat[nextIndex].editorSurface.focusEditor();
			} else if (!event.shiftKey) {
				const newTable = addRow(this.descriptor.table, this.descriptor.table.body.length - 1);
				this.applyTableChangeHandler(newTable, { row: this.descriptor.table.body.length + 1, col: 0 });
			}
		} else if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			this.markSkipBlurSync();
			this.syncDirtyCells();
			const totalRows = this.descriptor.table.body.length + 1;
			const numCols = this.descriptor.table.header.cells.length;
			if (row === totalRows - 1 && col === numCols - 1) {
				this.applyTableChangeHandler(addRow(this.descriptor.table, this.descriptor.table.body.length - 1), { row: totalRows, col: 0 });
			} else {
				this.controller?.flushDescriptor(this.descriptor);
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cell.editorSurface.blurEditor();
		}
	}

	public handleContainerMouseDown(event: MouseEvent) {
		if (event.target !== this.container) return;
		event.preventDefault();
		this.scrollbarDragging = true;
		const onUp = () => {
			this.scrollbarDragging = false;
			this.doc.removeEventListener('mouseup', onUp);
			if (this.lastFocusedCell && this.container.isConnected) {
				this.lastFocusedCell.editorSurface.focusEditor();
			}
		};
		this.doc.addEventListener('mouseup', onUp);
	}

	public syncDirtyCells() {
		for (const cell of this.getFlatCells()) {
			this.commitCellDraft(cell);
		}
	}

	public highlightRow(rowIdx: number) {
		if (rowIdx >= 0 && rowIdx < this.allCells.length) {
			for (const cell of this.allCells[rowIdx]) {
				cell?.cellElement.classList.add('cm-tw-hl');
			}
		}
	}

	public highlightCol(colIdx: number) {
		for (const row of this.allCells) {
			if (colIdx >= 0 && colIdx < row.length) {
				row[colIdx]?.cellElement.classList.add('cm-tw-hl');
			}
		}
	}

	public clearHighlight() {
		for (const element of this.tableElement.querySelectorAll('.cm-tw-hl')) {
			element.classList.remove('cm-tw-hl');
		}
	}

	public dispose() {
		for (const cell of this.getFlatCells()) {
			cell.dispose();
		}
		this.allCells = [];
		this.controller?.unregisterSession(this.descriptor, this);
	}

	private commitCellDraft(cell: CellView) {
		this.controller?.updateCell(this.descriptor, cell.coordinates, cell.editorSurface.getDraftText());
	}

	private markSkipBlurSync() {
		this.skipBlurSync = true;
	}

	private consumeSkipBlurSync() {
		if (!this.skipBlurSync) return false;
		this.skipBlurSync = false;
		return true;
	}
}

class TableWidget extends WidgetType {
	public constructor(
		private descriptor: TableDescriptor,
	) {
		super();
		this.cacheKey_ = `table_${descriptor.id}_${descriptor.contentVersion}_${descriptor.structureVersion}`;
		this.renderVersion_ = descriptor.renderVersion;
		this.structureVersion_ = descriptor.structureVersion;
	}

	private cacheKey_: string;
	private renderVersion_: number;
	private structureVersion_: number;

	public eq(other: TableWidget) {
		return this.descriptor === other.descriptor
			&& this.renderVersion_ === other.renderVersion_
			&& this.structureVersion_ === other.structureVersion_;
	}

	public get estimatedHeight() {
		return tableHeightCache.get(this.cacheKey_) ?? -1;
	}

	// Find this widget's container after a rebuild by matching the document position.
	private findContainer(view: EditorView): HTMLElement | null {
		return view.dom.querySelector<HTMLElement>(`.${W}[data-table-id="${this.descriptor.id}"]`);
	}

	// Save the horizontal scroll position of this widget's container before
	// a dispatch that will rebuild the widget, then restore it after rebuild.
	private saveAndRestoreScroll(view: EditorView, nextTable: Table | null) {
		const container = this.findContainer(view);
		const scrollLeft = container ? container.scrollLeft : 0;
		if (container && nextTable) {
			const nextCacheKey = this.cacheKeyFor(this.descriptor, nextTable);
			tableHeightCache.set(nextCacheKey, container.offsetHeight);
		}
		this.descriptor.scrollLeft = scrollLeft;
		if (scrollLeft > 0) {
			requestAnimationFrame(() => {
				const newContainer = this.findContainer(view);
				if (newContainer) newContainer.scrollLeft = scrollLeft;
			});
		}
	}

	// Dispatch a structural table change (add/delete row/column).
	// A trailing newline is appended when needed to ensure a blank line
	// separates the table from subsequent text, preventing the parser
	// from absorbing later lines as extra table rows.
	private apply(view: EditorView, newTable: Table | null, pendingFocus: CellCoord | null = null) {
		this.saveAndRestoreScroll(view, newTable);
		view.plugin(tableEditingPlugin)?.mutateTable(this.descriptor, newTable, pendingFocus);
	}

	private focusAfterInsertedRow(insertedRow: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		return {
			row: active.row >= insertedRow ? active.row + 1 : active.row,
			col: active.col,
		};
	}

	private focusAfterInsertedColumn(insertedCol: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		return {
			row: active.row,
			col: active.col >= insertedCol ? active.col + 1 : active.col,
		};
	}

	private focusAfterDeletedRow(deletedRow: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		if (active.row === deletedRow) return fallback;
		return {
			row: active.row > deletedRow ? active.row - 1 : active.row,
			col: active.col,
		};
	}

	private focusAfterDeletedColumn(deletedCol: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		if (active.col === deletedCol) return fallback;
		return {
			row: active.row,
			col: active.col > deletedCol ? active.col - 1 : active.col,
		};
	}

	private focusAfterSwappedRows(rowA: number, rowB: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		if (active.row === rowA) return { row: rowB, col: active.col };
		if (active.row === rowB) return { row: rowA, col: active.col };
		return active;
	}

	private focusAfterSwappedColumns(colA: number, colB: number, fallback: CellCoord) {
		const active = this.descriptor.activeCell;
		if (!active) return fallback;
		if (active.col === colA) return { row: active.row, col: colB };
		if (active.col === colB) return { row: active.row, col: colA };
		return active;
	}

	private cacheKeyFor(descriptor: TableDescriptor, table: Table) {
		const structureVersion = table === descriptor.table ? descriptor.structureVersion : descriptor.structureVersion + 1;
		const contentVersion = table === descriptor.table ? descriptor.contentVersion : descriptor.contentVersion + 1;
		return `table_${descriptor.id}_${contentVersion}_${structureVersion}`;
	}

	public toDOM(view: EditorView) {
		// Use the owning document/window instead of globals so that
		// the widget works correctly in separate Electron windows.
		const doc = view.dom.ownerDocument;
		const win = doc.defaultView!;

		const table = this.descriptor.table;
		if (!table) {
			const pre = doc.createElement('pre');
			pre.textContent = this.descriptor.sourceText;
			return pre;
		}

		const numCols = table.header.cells.length;
		const numBodyRows = table.body.length;
		const allCells: HTMLElement[][] = [];
		const controller = view.plugin(tableEditingPlugin);

		const container = doc.createElement('div');
		container.classList.add(W);
		container.dataset.tableId = this.descriptor.id;

		const tableEl = doc.createElement('table');
		const measureRenderedHeight = () => {
			if (container.isConnected) {
				tableHeightCache.set(this.cacheKey_, container.offsetHeight);
				view.requestMeasure();
			}
		};
		const session = new TableWidgetSession(
			view,
			this.descriptor,
			container,
			tableEl,
			doc,
			controller ?? null,
			measureRenderedHeight,
			(newTable, pendingFocus = null) => this.apply(view, newTable, pendingFocus),
		);
		tableSessionByContainer.set(container, session);
		controller?.registerSession(this.descriptor, session);

		// Sync all dirty cells back to the table model (without dispatching).
		// Must be called before any structural apply() so edits are not lost.
		const syncDirtyCells = () => {
			session.syncDirtyCells();
		};

		// ---- Editable cell ----
		const mkCell = (text: string, r: number, c: number, isHdr: boolean) => {
			const cell = new CellView(doc, { row: r, col: c }, text, isHdr, session, (event, coord) => showCtx(event, coord.row, coord.col));
			session.registerCell(cell);
			return cell.cellElement;
		};

		// ---- Hover "+" buttons (absolute positioned) ----
		// These are tiny buttons that sit on the right/bottom edge of each cell
		// and appear only on hover. No extra columns needed.

		const mkAddColBtn = (afterCol: number, anchorCell: HTMLElement) => {
			const wrapper = doc.createElement('span');
			wrapper.contentEditable = 'false';
			wrapper.classList.add('cm-tw-ac-wrap');
			const btn = doc.createElement('button');
			btn.classList.add('cm-tw-ac');
			btn.textContent = '+';
			btn.title = 'Add column to the right';
			btn.tabIndex = -1;
			btn.onmousedown = (e) => {
				if (e.button !== 0) return; // left-click only
				e.preventDefault();
				e.stopPropagation();
				syncDirtyCells();
				const insertedCol = afterCol + 1;
				this.apply(view, addColumn(table, afterCol), this.focusAfterInsertedColumn(insertedCol, { row: 0, col: insertedCol }));
			};
			wrapper.appendChild(btn);
			anchorCell.appendChild(wrapper);
		};

		const mkAddRowBtn = (afterBodyIdx: number, anchorCell: HTMLElement) => {
			const wrapper = doc.createElement('span');
			wrapper.contentEditable = 'false';
			wrapper.classList.add('cm-tw-ar-wrap');
			const btn = doc.createElement('button');
			btn.classList.add('cm-tw-ar');
			btn.textContent = '+';
			btn.title = 'Add row below';
			btn.tabIndex = -1;
			btn.onmousedown = (e) => {
				if (e.button !== 0) return; // left-click only
				e.preventDefault();
				e.stopPropagation();
				syncDirtyCells();
				const insertedRow = afterBodyIdx + 2;
				this.apply(view, addRow(table, afterBodyIdx), this.focusAfterInsertedRow(insertedRow, { row: insertedRow, col: 0 }));
			};
			wrapper.appendChild(btn);
			anchorCell.appendChild(wrapper);
		};

		// ---- Build header ----
		const thead = doc.createElement('thead');
		const headerTr = doc.createElement('tr');
		allCells[0] = [];
		for (let c = 0; c < numCols; c++) {
			const cell = mkCell(table.header.cells[c].content, 0, c, true);
			// "+" on right edge of every header cell → add column
			mkAddColBtn(c, cell);
			// "+" on bottom edge of first header cell → add row below header
			if (c === 0) mkAddRowBtn(-1, cell);
			allCells[0].push(cell);
			headerTr.appendChild(cell);
		}
		thead.appendChild(headerTr);
		tableEl.appendChild(thead);

		// ---- Build body ----
		const tbody = doc.createElement('tbody');
		for (let r = 0; r < numBodyRows; r++) {
			const tr = doc.createElement('tr');
			allCells[r + 1] = [];
			for (let c = 0; c < numCols; c++) {
				const content = c < table.body[r].cells.length ? table.body[r].cells[c].content : '';
				const cell = mkCell(content, r + 1, c, false);
				// "+" on bottom edge of first column cell → add row
				if (c === 0) mkAddRowBtn(r, cell);
				allCells[r + 1].push(cell);
				tr.appendChild(cell);
			}
			tbody.appendChild(tr);
		}
		tableEl.appendChild(tbody);
		container.appendChild(tableEl);

		// ---- Highlight helpers ----
		const highlightRow = (rowIdx: number) => {
			if (rowIdx >= 0 && rowIdx < allCells.length) {
				for (const cell of allCells[rowIdx]) {
					cell.classList.add('cm-tw-hl');
				}
			}
		};
		const highlightCol = (colIdx: number) => {
			for (const row of allCells) {
				if (colIdx >= 0 && colIdx < row.length) {
					row[colIdx].classList.add('cm-tw-hl');
				}
			}
		};
		const clearHighlight = () => {
			for (const el of tableEl.querySelectorAll('.cm-tw-hl')) {
				el.classList.remove('cm-tw-hl');
			}
		};

		// ---- Context menu ----
		const showCtx = (e: MouseEvent, r: number, c: number) => {
			e.preventDefault();
			container.querySelector(`.${CTX}`)?.remove();
			clearHighlight();

			const menu = doc.createElement('div');
			menu.classList.add(CTX);
			// Use viewport coordinates since the menu is position:fixed
			menu.style.left = `${e.clientX}px`;
			menu.style.top = `${e.clientY}px`;

			type MenuItem = { label: string; action: ()=> void; hlRow?: number; hlCol?: number };
			const items: MenuItem[] = [
				{ label: '+ Insert row above', action: () => {
					syncDirtyCells();
					const insertedRow = Math.max(1, r);
					this.apply(view, addRow(table, r <= 0 ? -1 : r - 2), this.focusAfterInsertedRow(insertedRow, { row: insertedRow, col: c }));
				} },
				{ label: '+ Insert row below', action: () => {
					syncDirtyCells();
					const insertedRow = r + 1;
					this.apply(view, addRow(table, r === 0 ? -1 : r - 1), this.focusAfterInsertedRow(insertedRow, { row: insertedRow, col: c }));
				} },
				{ label: '+ Insert column left', action: () => {
					syncDirtyCells();
					this.apply(view, addColumn(table, c - 1), this.focusAfterInsertedColumn(c, { row: r, col: c }));
				} },
				{ label: '+ Insert column right', action: () => {
					syncDirtyCells();
					const insertedCol = c + 1;
					this.apply(view, addColumn(table, c), this.focusAfterInsertedColumn(insertedCol, { row: r, col: insertedCol }));
				} },
			];
			if (r > 1) {
				items.push({ label: '↑ Move row up', action: () => {
					syncDirtyCells();
					this.apply(view, swapRows(table, r - 1, r - 2), this.focusAfterSwappedRows(r, r - 1, { row: r - 1, col: c }));
				}, hlRow: r });
			}
			if (r > 0 && r < numBodyRows) {
				items.push({ label: '↓ Move row down', action: () => {
					syncDirtyCells();
					this.apply(view, swapRows(table, r - 1, r), this.focusAfterSwappedRows(r, r + 1, { row: r + 1, col: c }));
				}, hlRow: r });
			}
			if (c > 0) {
				items.push({ label: '← Move column left', action: () => {
					syncDirtyCells();
					this.apply(view, swapColumns(table, c, c - 1), this.focusAfterSwappedColumns(c, c - 1, { row: r, col: c - 1 }));
				}, hlCol: c });
			}
			if (c < numCols - 1) {
				items.push({ label: '→ Move column right', action: () => {
					syncDirtyCells();
					this.apply(view, swapColumns(table, c, c + 1), this.focusAfterSwappedColumns(c, c + 1, { row: r, col: c + 1 }));
				}, hlCol: c });
			}
			// Delete row: only for body rows (header row cannot be removed)
			if (r > 0) {
				items.push({
					label: '✕ Delete row',
					action: () => {
						syncDirtyCells();
						this.apply(view, deleteRow(table, r - 1), this.focusAfterDeletedRow(r, { row: Math.min(r, numBodyRows - 1), col: c }));
					},
					hlRow: r,
				});
			}
			// Delete column: last column → delete entire table, otherwise delete that column
			items.push({
				label: '✕ Delete column',
				action: () => {
					syncDirtyCells();
					if (numCols <= 1) {
						controller?.deleteTable(this.descriptor);
					} else {
						this.apply(view, deleteColumn(table, c), this.focusAfterDeletedColumn(c, { row: r, col: Math.min(c, numCols - 2) }));
					}
				},
				hlCol: c,
			});

			for (const item of items) {
				const div = doc.createElement('div');
				div.textContent = item.label;
				div.onmouseenter = () => {
					clearHighlight();
					if (item.hlRow !== undefined) highlightRow(item.hlRow);
					if (item.hlCol !== undefined) highlightCol(item.hlCol);
				};
				div.onmouseleave = () => clearHighlight();
				div.onmousedown = (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					clearHighlight();
					menu.remove();
					item.action();
				};
				menu.appendChild(div);
			}
			container.appendChild(menu);
			// Clamp menu position so it stays within the viewport
			const menuRect = menu.getBoundingClientRect();
			const vw = win.innerWidth;
			const vh = win.innerHeight;
			if (menuRect.right > vw) menu.style.left = `${vw - menuRect.width - 4}px`;
			if (menuRect.bottom > vh) menu.style.top = `${vh - menuRect.height - 4}px`;
			const close = () => {
				clearHighlight();
				menu.remove();
				doc.removeEventListener('mousedown', close);
				win.removeEventListener('scroll', close, true);
			};
			setTimeout(() => {
				doc.addEventListener('mousedown', close);
				// Close menu on any scroll (capture phase catches scrollable parents)
				win.addEventListener('scroll', close, true);
			}, 0);
		};

		// Measure and cache the rendered height so CodeMirror can correctly
		// calculate scroll positions and coordinate mapping.
		requestAnimationFrame(() => {
			measureRenderedHeight();
		});

		// Detect scrollbar/container clicks — prevent cell blur so the
		// widget is not rebuilt mid-scroll and the cell editor stays open.
		container.addEventListener('mousedown', (e) => {
			session.handleContainerMouseDown(e);
		});
		container.addEventListener('scroll', () => {
			this.descriptor.scrollLeft = container.scrollLeft;
		});

		return container;
	}

	public destroy(dom: HTMLElement) {
		const session = tableSessionByContainer.get(dom);
		session?.dispose();
	}

	public ignoreEvent() { return true; }
}

// ===================== THEME =====================
const tableTheme = EditorView.theme({
	// Root — no border, no background, just positioning context
	[`& .${W}`]: {
		position: 'relative',
		display: 'block',
		width: '100%',
		maxWidth: '100%',
		overflowX: 'auto',
		contain: 'inline-size',
		outline: 'none',
		padding: '18px 14px',
		boxSizing: 'border-box',
	},
	[`& .${W} table`]: {
		borderCollapse: 'collapse',
		tableLayout: 'auto',
	},

	// Cells
	[`& .${CELL}`]: {
		border: '1px solid var(--joplin-divider-color, #ddd)',
		padding: '6px 10px',
		minWidth: '50px',
		outline: 'none',
		verticalAlign: 'top',
		lineHeight: '1.5',
		fontSize: 'inherit',
		fontFamily: 'inherit',
		position: 'relative', // anchor for + buttons
	},
	// Editable text area inside cells
	['& .cm-tw-text']: {
		outline: 'none',
		minHeight: '1.2em',
		height: '100%',
		width: '100%',
		display: 'block',
		cursor: 'text',
		margin: '0',
		padding: '0',
		boxSizing: 'border-box',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	['& .cm-tw-text:focus']: {
		outline: 'none',
	},
	// Highlight the entire cell when its text div is focused
	[`& .${CELL}:focus-within`]: {
		backgroundColor: 'var(--joplin-selected-color, rgba(0,120,255,0.06))',
		boxShadow: 'inset 0 0 0 2px var(--joplin-color3, #0078ff)',
	},
	[`& .${HDR}`]: {
		fontWeight: 'bold',
		backgroundColor: 'var(--joplin-background-color3, #f0f0f0)',
	},

	// Highlight for row/column on context menu hover
	['& .cm-tw-hl']: {
		backgroundColor: 'var(--joplin-selected-color, rgba(0,120,255,0.12)) !important',
	},

	// Wrapper for "+" buttons — non-editable island inside contentEditable cells
	['& .cm-tw-ac-wrap']: {
		position: 'absolute',
		top: '50%',
		right: '-12px',
		transform: 'translateY(-50%)',
		zIndex: '30',
		display: 'none',
	},
	[`& .${CELL}:hover > .cm-tw-ac-wrap`]: {
		display: 'block',
	},
	['& .cm-tw-ar-wrap']: {
		position: 'absolute',
		bottom: '-12px',
		left: '50%',
		transform: 'translateX(-50%)',
		zIndex: '30',
		display: 'none',
	},
	[`& .${CELL}:hover > .cm-tw-ar-wrap`]: {
		display: 'block',
	},
	// "+" button styles (shared)
	['& .cm-tw-ac, & .cm-tw-ar']: {
		width: '22px',
		height: '22px',
		lineHeight: '20px',
		fontSize: '16px',
		fontWeight: 'bold',
		border: '1px solid var(--joplin-divider-color, #ccc)',
		borderRadius: '50%',
		backgroundColor: 'var(--joplin-background-color, #fff)',
		color: 'var(--joplin-color3, #0078ff)',
		cursor: 'pointer',
		padding: '0',
		textAlign: 'center',
		'&:hover': {
			backgroundColor: 'var(--joplin-color3, #0078ff)',
			color: '#fff',
			borderColor: 'var(--joplin-color3, #0078ff)',
		},
	},

	// Context menu
	[`& .${CTX}`]: {
		position: 'fixed',
		backgroundColor: 'var(--joplin-background-color, #fff)',
		border: '1px solid var(--joplin-divider-color, #ccc)',
		borderRadius: '6px',
		boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
		zIndex: '100',
		minWidth: '190px',
		padding: '4px 0',
		fontSize: '13px',
		'& > div': {
			padding: '6px 14px',
			cursor: 'pointer',
			whiteSpace: 'nowrap',
			'&:hover': {
				backgroundColor: 'var(--joplin-background-color-hover3, #f0f0f0)',
			},
		},
	},
});

// ===================== EXTENSION =====================
const renderTables = [
	tableTheme,
	tableDescriptorField,
	tableEditingPlugin,
	EditorView.domEventHandlers({
		mousedown: (event) => {
			if ((event.target as Element).closest(`.${W}`)) return true;
			return false;
		},
	}),
];

export default renderTables;
