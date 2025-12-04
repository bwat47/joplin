import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

// Auto-completes fenced code blocks by adding closing backticks after typing three opening backticks
const autoCloseFencedCodeBlockExtension = () => {
	return EditorView.inputHandler.of((view: EditorView, from: number, to: number, text: string): boolean => {
		// Only handle single backtick input
		if (text !== '`') {
			return false;
		}

		const state = view.state;
		const doc = state.doc;

		// Get text before cursor
		const lineStart = doc.lineAt(from).from;
		const textBeforeCursor = doc.sliceString(lineStart, from);

		// Check if we just typed the third backtick in a sequence
		// Pattern: line starts with exactly two backticks (possibly with leading whitespace)
		const tripleBacktickMatch = /^(\s*)``$/.test(textBeforeCursor);

		if (!tripleBacktickMatch) {
			return false;
		}

		// Check syntax tree to see if we're already inside a FencedCode block
		const tree = syntaxTree(state);
		const nodeAtCursor = tree.resolveInner(from, -1);

		// If we're inside a FencedCode block, we're likely closing it, not opening
		// Walk up the tree to check if any parent is FencedCode
		let node = nodeAtCursor;
		while (node) {
			if (node.name === 'FencedCode') {
				// We're inside a fenced code block, so this is likely a closing sequence
				// Let the default behavior handle it (don't auto-complete)
				return false;
			}
			node = node.parent;
		}

		// We're opening a new fenced code block!
		// Insert: backtick + newline + newline + three backticks
		const indent = textBeforeCursor.match(/^(\s*)/)?.[1] || '';
		const insert = `\`\n${indent}\n${indent}\`\`\``;

		const changes = state.changes({
			from: from,
			to: to,
			insert: insert,
		});

		// Position cursor on the middle line (after first newline)
		const cursorPos = from + 2 + indent.length; // backtick + newline + indent

		view.dispatch({
			changes,
			selection: { anchor: cursorPos },
			userEvent: 'input.type',
		});

		return true;
	});
};

export default autoCloseFencedCodeBlockExtension;
