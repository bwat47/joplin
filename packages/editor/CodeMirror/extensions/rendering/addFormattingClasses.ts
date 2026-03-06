import { Decoration, EditorView } from '@codemirror/view';
import makeInlineReplaceExtension from './utils/makeInlineReplaceExtension';
import { InlineMarkupRenderMode } from '../../../types';

const linkClassName = 'cm-ext-unfocused-link';
const urlMarkDecoration = Decoration.mark({ class: linkClassName });
const strikethroughClassName = 'cm-ext-strikethrough';
const strikethroughMarkDecoration = Decoration.mark({ class: strikethroughClassName });

const addFormattingClasses = (renderMode: InlineMarkupRenderMode = InlineMarkupRenderMode.Normal) => {
	return [
		EditorView.theme({
			[`& .${linkClassName}, & .${linkClassName} span`]: {
				textDecoration: 'underline',
			},
			[`& .${strikethroughClassName}, & .${strikethroughClassName} span`]: {
				textDecoration: 'line-through',
			},
		}),
		makeInlineReplaceExtension({
			getRevealStrategy: renderMode === InlineMarkupRenderMode.Normal ? (node) => {
				// Links: use 'select' because the Link's parent is Paragraph,
				// which spans the whole line - 'active' would hide all link decorations on the line
				if (node.name === 'URL' || node.name === 'Link') {
					return 'select';
				}
				return 'active';
			} : undefined,
			createDecoration: (node) => {
				if (node.name === 'URL' || node.name === 'Link') {
					return urlMarkDecoration;
				}
				if (node.name === 'Strikethrough') {
					return strikethroughMarkDecoration;
				}
				return null;
			},
		}),
	];
};

export default addFormattingClasses;
