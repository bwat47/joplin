import { EditorState, Line } from '@codemirror/state';
import uslug from '@joplin/fork-uslug/lib/uslug';
import createHashTracker from '../../../utils/createHashTracker';

// Searches the given `state` for a line that matches the target link.
const findLineMatchingLink = (link: string, state: EditorState): Line|null => {
	const isAnchorLink = link.startsWith('#');
	const isFootnote = link.startsWith('[^') && link.endsWith(']');

	if (!isAnchorLink && !isFootnote) return null;

	// Track seen hashes to handle duplicate headings (e.g., two "## Heading" become "heading" and "heading-2")
	const hashTracker = createHashTracker();
	const targetHash = link.substring(1);

	const matchesLine = (line: string) => {
		if (isAnchorLink) {
			// Check if this line is a heading
			const headingMatch = line.match(/^#+\s/);
			if (!headingMatch) return false;

			const headingText = line.replace(/^#+/, '').trim();
			const originalHash = uslug(headingText);
			const uniqueHash = hashTracker.getUniqueHash(originalHash);
			return uniqueHash === targetHash;
		} else if (isFootnote) {
			return line.trim().startsWith(`${link}:`);
		}
		return false;
	};

	let iterator = state.doc.iterLines();
	let lineNumber = 0;
	while (!iterator.done && lineNumber <= state.doc.lines) {
		lineNumber ++;
		iterator = iterator.next();
		const line = iterator.value;

		if (matchesLine(line)) {
			return state.doc.line(lineNumber);
		}
	}

	return null;
};

export default findLineMatchingLink;
