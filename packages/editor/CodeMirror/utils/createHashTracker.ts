// Creates a hash tracker for handling duplicate headings.
// When multiple headings have the same text, their hashes get suffixed:
// - First "## Heading" → "heading"
// - Second "## Heading" → "heading-2"
// - Third "## Heading" → "heading-3"
const createHashTracker = () => {
	const seenHashes = new Map<string, number>();

	return {
		// Returns a unique hash, appending -2, -3, etc. for duplicates
		getUniqueHash: (originalHash: string): string => {
			const count = seenHashes.get(originalHash) ?? 0;
			seenHashes.set(originalHash, count + 1);

			if (count === 0) {
				return originalHash;
			}
			return `${originalHash}-${count + 1}`;
		},
	};
};

export default createHashTracker;
