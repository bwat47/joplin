// Joplin-native interactive table editor widget for CodeMirror 6.
// Clean design: no grip columns, table stays flush-left.
// - Hover near row/column edges → "+" button appears via absolute positioning
// - Right-click any cell → context menu for insert/move/delete
// - Enter in last cell → adds new row
// - Tab/Shift+Tab → navigate cells

import { EditorView, WidgetType, Decoration, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Annotation, EditorState, Range, StateField, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { focus, blur } from '@joplin/lib/utils/focusHandler';
import {
	parseTable, serializeTable,
	addRow, addColumn, deleteRow, deleteColumn,
	swapRows, swapColumns,
	Table,
} from '../../utils/markdown/tableUtils';
import { getCellContentPosition } from '../../editorCommands/tableCommands';

// Short class name prefix
const W = 'cm-tw';
const CELL = 'cm-tw-c';
const HDR = 'cm-tw-h';
const CTX = 'cm-tw-ctx';

// Cache for rendered table widget heights so CodeMirror can estimate
// heights correctly for scroll position and coordinate mapping.
const tableHeightCache = new Map<string, number>();

type CellCoord = { row: number; col: number };
type CellSelection = { anchor: number; head: number };

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
		return tableCellContent.replace(/<br>/gi, '\n').replace(/\\\|/g, '|');
	},

	toTableCellContent: (draft: string): string => {
		return draft.replace(/\n/g, '<br>').replace(/\|/g, '\\|');
	},
};

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
		}

		descriptors.push(descriptor);
	}
	return descriptors;
};

export const testing__resetTableDescriptorIds = () => {
	nextTableDescriptorId = 1;
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
	public constructor(private view: EditorView) {}

	public update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.restorePendingFocus();
		}
	}

	public destroy() {
		for (const descriptor of this.view.state.field(tableDescriptorField, false) ?? []) {
			this.flushDescriptor(descriptor);
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
		descriptor.pendingFocus ??= descriptor.activeCell;
		this.view.dispatch({
			changes: {
				from: descriptor.from,
				to: descriptor.to,
				insert: tableTextWithFollowingSeparator(this.view, descriptor, tableText),
			},
			selection: { anchor: descriptor.from, head: descriptor.from },
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
				const target = container.querySelector<HTMLElement>(`.cm-tw-text[data-row="${coord.row}"][data-col="${coord.col}"]`);
				if (target) focus('TableWidget', target);
			});
		}
	}

	private findContainer(descriptor: TableDescriptor): HTMLElement | null {
		return this.view.dom.querySelector<HTMLElement>(`.${W}[data-table-id="${descriptor.id}"]`);
	}
}

const tableEditingPlugin = ViewPlugin.fromClass(TableEditingController);

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
	private saveAndRestoreScroll(view: EditorView) {
		const container = this.findContainer(view);
		const scrollLeft = container ? container.scrollLeft : 0;
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
		this.saveAndRestoreScroll(view);
		view.plugin(tableEditingPlugin)?.mutateTable(this.descriptor, newTable, pendingFocus);
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
		const totalRows = numBodyRows + 1;
		const allCells: HTMLElement[][] = [];
		const controller = view.plugin(tableEditingPlugin);

		const container = doc.createElement('div');
		container.classList.add(W);
		container.dataset.tableId = this.descriptor.id;

		const tableEl = doc.createElement('table');

		// Flag to skip onblur sync when Tab/Enter handles it
		let skipBlurSync = false;

		// Track scrollbar interaction to prevent widget rebuild during drag
		let scrollbarDragging = false;
		let lastFocusedTextDiv: HTMLElement | null = null;

		// Sync all dirty cells back to the table model (without dispatching).
		// Must be called before any structural apply() so edits are not lost.
		const syncDirtyCells = () => {
			controller?.updateAllCellsFromDOM(this.descriptor, container);
		};

		// ---- Editable cell ----
		const mkCell = (text: string, r: number, c: number, isHdr: boolean) => {
			const el = doc.createElement(isHdr ? 'th' : 'td');
			el.classList.add(CELL);
			if (isHdr) el.classList.add(HDR);

			// Editable text lives in its own div — cell itself is NOT editable
			const textDiv = doc.createElement('div');
			textDiv.classList.add('cm-tw-text');
			textDiv.dataset.row = `${r}`;
			textDiv.dataset.col = `${c}`;
			textDiv.contentEditable = 'true';
			textDiv.spellcheck = false;
			textDiv.textContent = cellTextCodec.toDraft(text);

			// Sync CM cursor to this cell so toolbar commands work
			textDiv.onfocus = () => {
				lastFocusedTextDiv = textDiv;
				controller?.markCellActive(this.descriptor, r, c);
			};

			textDiv.oninput = () => {
				controller?.updateCell(this.descriptor, { row: r, col: c }, textDiv.textContent || '');
			};

			textDiv.onblur = () => {
				if (skipBlurSync) { skipBlurSync = false; return; }
				// Defer sync so that a click on another cell in the same
				// table can register before the widget rebuilds.
				setTimeout(() => {
					// If the widget was rebuilt (e.g. by a "+" button or
					// context menu action), the old container is detached.
					// Do nothing — the rebuild already has the latest data.
					if (!container.isConnected) return;
					const v = textDiv.textContent || '';
					const orig = isHdr
						? table.header.cells[c]?.content
						: table.body[r - 1]?.cells[c]?.content;
					if (cellTextCodec.toTableCellContent(v) === orig) return;
					// If focus moved to another cell in this table, just
					// update the in-memory model — no dispatch/rebuild.
					// The markdown will sync on next structural edit or
					// when focus leaves the table entirely.
					if (scrollbarDragging || container.contains(doc.activeElement)) {
						controller?.updateCell(this.descriptor, { row: r, col: c }, v);
					} else {
						// Focus left the table — sync all dirty cells to markdown
						syncDirtyCells();
						controller?.flushDescriptor(this.descriptor);
					}
				}, 80);
			};

			textDiv.onkeydown = (e) => {
				// Block newlines — not allowed in markdown table cells
				if (e.key === 'Enter' && e.shiftKey) {
					e.preventDefault();
					return;
				}
				if (e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();

					skipBlurSync = true;

					// Sync all dirty cells into the table model first
					syncDirtyCells();

					// Check if any cell content actually changed
					const newText = serializeTable(table);
					const isDirty = newText !== this.descriptor.lastDispatchedText;

					// Compute target cell index
					const flat = allCells.flat();
					const i = flat.indexOf(el);
					const nextIdx = e.shiftKey ? i - 1 : i + 1;

					if (nextIdx >= 0 && nextIdx < flat.length) {
						if (isDirty) {
							// Content changed — apply and refocus after rebuild
							const targetCell = flat[nextIdx] as HTMLElement;
							this.apply(view, table, {
								row: Number(targetCell.querySelector<HTMLElement>('.cm-tw-text')?.dataset.row ?? 0),
								col: Number(targetCell.querySelector<HTMLElement>('.cm-tw-text')?.dataset.col ?? 0),
							});
						} else {
							// No changes — just move focus, no rebuild needed
							const targetText = flat[nextIdx].querySelector('.cm-tw-text') as HTMLElement;
							if (targetText) focus('TableWidget', targetText);
						}
					} else if (!e.shiftKey) {
						// Past last cell — add new row and focus its first cell
						const newTable = addRow(table, numBodyRows - 1);
						this.apply(view, newTable, { row: totalRows, col: 0 });
					}
				} else if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					skipBlurSync = true;
					syncDirtyCells();
					if (r === totalRows - 1 && c === numCols - 1) {
						this.apply(view, addRow(table, numBodyRows - 1), { row: totalRows, col: 0 });
					} else {
						// Only apply if content actually changed
						const enterText = serializeTable(table);
						if (enterText !== this.descriptor.lastDispatchedText) {
							this.apply(view, table);
						}
					}
				} else if (e.key === 'Escape') {
					e.preventDefault();
					blur('TableWidget', textDiv);
				}
			};

			el.appendChild(textDiv);
			// Clicking anywhere in the cell (including empty space in tall rows)
			// should activate the text editor
			el.onmousedown = (e) => {
				if (e.target === el) {
					e.preventDefault();
					focus('TableWidget', textDiv);
				}
			};
			el.oncontextmenu = (e) => showCtx(e, r, c);

			return el;
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
				this.apply(view, addColumn(table, afterCol), { row: 0, col: afterCol + 1 });
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
				this.apply(view, addRow(table, afterBodyIdx), { row: afterBodyIdx + 2, col: 0 });
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
				{ label: '+ Insert row above', action: () => { syncDirtyCells(); this.apply(view, addRow(table, r <= 0 ? -1 : r - 2), { row: Math.max(1, r), col: c }); } },
				{ label: '+ Insert row below', action: () => { syncDirtyCells(); this.apply(view, addRow(table, r === 0 ? -1 : r - 1), { row: r + 1, col: c }); } },
				{ label: '+ Insert column left', action: () => { syncDirtyCells(); this.apply(view, addColumn(table, c - 1), { row: r, col: c }); } },
				{ label: '+ Insert column right', action: () => { syncDirtyCells(); this.apply(view, addColumn(table, c), { row: r, col: c + 1 }); } },
			];
			if (r > 1) items.push({ label: '↑ Move row up', action: () => { syncDirtyCells(); this.apply(view, swapRows(table, r - 1, r - 2), { row: r - 1, col: c }); }, hlRow: r });
			if (r > 0 && r < numBodyRows) items.push({ label: '↓ Move row down', action: () => { syncDirtyCells(); this.apply(view, swapRows(table, r - 1, r), { row: r + 1, col: c }); }, hlRow: r });
			if (c > 0) items.push({ label: '← Move column left', action: () => { syncDirtyCells(); this.apply(view, swapColumns(table, c, c - 1), { row: r, col: c - 1 }); }, hlCol: c });
			if (c < numCols - 1) items.push({ label: '→ Move column right', action: () => { syncDirtyCells(); this.apply(view, swapColumns(table, c, c + 1), { row: r, col: c + 1 }); }, hlCol: c });
			// Delete row: only for body rows (header row cannot be removed)
			if (r > 0) {
				items.push({
					label: '✕ Delete row',
					action: () => {
						syncDirtyCells();
						this.apply(view, deleteRow(table, r - 1), { row: Math.min(r, numBodyRows - 1), col: c });
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
						this.apply(view, deleteColumn(table, c), { row: r, col: Math.min(c, numCols - 2) });
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
			if (container.isConnected) {
				tableHeightCache.set(this.cacheKey_, container.offsetHeight);
			}
		});

		// Detect scrollbar/container clicks — prevent cell blur so the
		// widget is not rebuilt mid-scroll and the cell editor stays open.
		container.addEventListener('mousedown', (e) => {
			if (e.target === container) {
				e.preventDefault();
				scrollbarDragging = true;
				const onUp = () => {
					scrollbarDragging = false;
					doc.removeEventListener('mouseup', onUp);
					// If blur fired despite preventDefault, re-focus the cell
					if (lastFocusedTextDiv && container.isConnected &&
						doc.activeElement !== lastFocusedTextDiv) {
						focus('TableWidget', lastFocusedTextDiv);
					}
				};
				doc.addEventListener('mouseup', onUp);
			}
		});
		container.addEventListener('scroll', () => {
			this.descriptor.scrollLeft = container.scrollLeft;
		});

		return container;
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
