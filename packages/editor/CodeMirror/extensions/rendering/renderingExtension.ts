import addFormattingClasses from './addFormattingClasses';
import replaceBackslashEscapes from './replaceBackslashEscapes';
import replaceBulletLists from './replaceBulletLists';
import replaceCheckboxes from './replaceCheckboxes';
import replaceDividers from './replaceDividers';
import replaceFormatCharacters from './replaceFormatCharacters';
import replaceInlineHtml from './replaceInlineHtml';
import { InlineMarkupRenderMode } from '../../../types';

export default (renderMode: InlineMarkupRenderMode = InlineMarkupRenderMode.Normal) => {
	return [
		replaceCheckboxes,
		replaceBulletLists,
		replaceFormatCharacters(renderMode),
		replaceBackslashEscapes,
		replaceDividers,
		addFormattingClasses(renderMode),
		replaceInlineHtml,
	];
};
