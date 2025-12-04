import { EditorView } from '@codemirror/view';

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

		// Insert: backtick + newline + three backticks (user can press Enter to add content line)
		const indent = textBeforeCursor.match(/^(\s*)/)?.[1] || '';
		const insert = `\`\n${indent}\`\`\``;

		const changes = state.changes({
			from: from,
			to: to,
			insert: insert,
		});

		// Position cursor right after the third backtick so user can type language identifier
		const cursorPos = from + 1; // right after the inserted backtick

		view.dispatch({
			changes,
			selection: { anchor: cursorPos },
			userEvent: 'input.type',
		});

		return true;
	});
};

export default autoCloseFencedCodeBlockExtension;
