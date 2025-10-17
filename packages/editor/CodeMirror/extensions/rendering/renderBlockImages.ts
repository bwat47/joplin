import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { SyntaxNodeRef } from '@lezer/common';
import { EditorState, StateEffect, Transaction } from '@codemirror/state';
import { RenderedContentContext } from './types';
import makeBlockReplaceExtension from './utils/makeBlockReplaceExtension';

const imageClassName = 'cm-md-image';
// Pre-set the image height for performance (allows CodeMirror to better calculate
// the document height while scrolling). This is just an estimate - actual images
// will scale to their natural size.
const estimatedImageHeight = 200;

class ImageWidget extends WidgetType {
	private resolvedSrc_: string;

	public constructor(
		private readonly context_: RenderedContentContext,
		private readonly src_: string,
		private readonly alt_: string,
		private readonly width_?: string,
		private readonly height_?: string,
		private readonly reloadCounter_ = 0,
	) {
		super();
	}

	public eq(other: ImageWidget) {
		return this.src_ === other.src_ && this.alt_ === other.alt_ &&
			this.width_ === other.width_ && this.height_ === other.height_ &&
			this.reloadCounter_ === other.reloadCounter_;
	}

	public updateDOM(dom: HTMLElement): boolean {
		const image = dom.querySelector<HTMLImageElement>('img.image');
		if (!image) return false;

		image.alt = this.alt_;

		// Apply width and height if specified, otherwise clear them
		if (this.width_) {
			image.style.width = this.width_;
		} else {
			image.style.width = '';
		}
		if (this.height_) {
			image.style.height = this.height_;
		} else {
			image.style.height = '';
		}

		const updateImageUrl = () => {
			if (this.resolvedSrc_) {
				image.src = this.resolvedSrc_;
			}
		};

		if (!this.resolvedSrc_) {
			void (async () => {
				this.resolvedSrc_ = await this.context_.resolveImageSrc(this.src_, this.reloadCounter_);
				updateImageUrl();
			})();
		} else {
			updateImageUrl();
		}

		return true;
	}

	public toDOM() {
		const container = document.createElement('div');
		container.classList.add(imageClassName);

		const image = document.createElement('img');
		image.classList.add('image');

		container.appendChild(image);
		this.updateDOM(container);

		return container;
	}

	public get estimatedHeight() {
		// If height is specified, try to parse it for a better estimate
		if (this.height_) {
			const heightMatch = this.height_.match(/^(\d+)/);
			if (heightMatch) {
				return parseInt(heightMatch[1], 10);
			}
		}
		return estimatedImageHeight;
	}
}

const getImageSrc = (node: SyntaxNodeRef, state: EditorState) => {
	const nodeText = state.sliceDoc(node.from, node.to);

	// Check for HTML img tag first
	const htmlMatch = nodeText.match(/<img[^>]+src=["'](:\/[a-zA-Z0-9]{32})["'][^>]*>/);
	if (htmlMatch) {
		return htmlMatch[1];
	}

	// For now, only render Joplin resource images (avoid auto-fetching images from
	// the internet if just the Markdown editor is open).
	const match = nodeText.match(/:\/[a-zA-Z0-9]{32}/);
	if (match) {
		return match[0];
	}

	return null;
};

const getImageAlt = (node: SyntaxNodeRef, state: EditorState) => {
	const nodeText = state.sliceDoc(node.from, node.to);

	// Check for HTML img tag alt attribute
	const htmlMatch = nodeText.match(/<img[^>]+alt=["']([^"']*)["'][^>]*>/);
	if (htmlMatch) {
		return htmlMatch[1];
	}

	// Then check for Markdown format
	const match = nodeText.match(/!\s*\[(.+)\]/);
	if (match) {
		return match[1];
	}

	return null;
};

const getImageWidth = (node: SyntaxNodeRef, state: EditorState) => {
	const nodeText = state.sliceDoc(node.from, node.to);

	// Check for HTML img tag width attribute
	const htmlMatch = nodeText.match(/<img[^>]+width=["']?([^"'\s>]+)["']?[^>]*>/);
	if (htmlMatch) {
		const width = htmlMatch[1];
		// If it's just a number, add 'px' unit
		return /^\d+$/.test(width) ? `${width}px` : width;
	}

	return null;
};

const getImageHeight = (node: SyntaxNodeRef, state: EditorState) => {
	const nodeText = state.sliceDoc(node.from, node.to);

	// Check for HTML img tag height attribute
	const htmlMatch = nodeText.match(/<img[^>]+height=["']?([^"'\s>]+)["']?[^>]*>/);
	if (htmlMatch) {
		const height = htmlMatch[1];
		// If it's just a number, add 'px' unit
		return /^\d+$/.test(height) ? `${height}px` : height;
	}

	return null;
};

// In Electron: To work around browser caching, these counters should continue to increase even if an old
// editor is destroyed and a new one is created in the same window.
const imageToRefreshCounters = new Map<string, number>();
export const resetImageResourceEffect = StateEffect.define<{ id: string }>();

// Intended only for automated tests.
export const testing__resetImageRefreshCounterCache = () => {
	imageToRefreshCounters.clear();
};

const renderBlockImages = (context: RenderedContentContext) => [
	EditorView.theme({
		[`& .${imageClassName}`]: {
			display: 'block',
			textAlign: 'center',
			margin: '0.5em 0',
		},
		[`& .${imageClassName} > img`]: {
			maxWidth: '100%',
			height: 'auto',
			display: 'block',
			margin: '0 auto',
		},
	}),
	makeBlockReplaceExtension({
		createDecoration: (node, state) => {
			// Handle both Markdown Image nodes and HTML HTMLTag nodes
			if (node.name === 'Image') {
				const lineFrom = state.doc.lineAt(node.from);
				const lineTo = state.doc.lineAt(node.to);
				const textBefore = state.sliceDoc(lineFrom.from, node.from);
				const textAfter = state.sliceDoc(node.to, lineTo.to);
				if (textBefore.trim() === '' && textAfter.trim() === '') {
					const src = getImageSrc(node, state);
					const alt = getImageAlt(node, state);

					if (src) {
						const isLastLine = lineTo.number === state.doc.lines;
						return Decoration.widget({
							widget: new ImageWidget(context, src, alt, undefined, undefined, imageToRefreshCounters.get(src) ?? 0),
							// "side: -1": In general, when the cursor is at the widget's location, it should be at
							// the start of the next line (and so "side" should be -1).
							//
							// "side: 1": However, when the widget is at the end of the document, the widget's
							// position is **one index less** than when it isn't (to prevent the widget's
							// position from being outside the document, which would break CodeMirror).
							// This means that we need "side: 1" to put the cursor before the widget
							// when at the end of the document.
							side: isLastLine ? 1 : -1,
							block: true,
						});
					}
				}
			} else if (node.name === 'HTMLTag' || node.name === 'HTMLBlock') {
				// Check if this HTML contains an img tag
				const nodeText = state.sliceDoc(node.from, node.to);
				if (nodeText.includes('<img') && nodeText.match(/:\/[a-zA-Z0-9]{32}/)) {
					const lineFrom = state.doc.lineAt(node.from);
					const lineTo = state.doc.lineAt(node.to);
					const textBefore = state.sliceDoc(lineFrom.from, node.from);
					const textAfter = state.sliceDoc(node.to, lineTo.to);
					if (textBefore.trim() === '' && textAfter.trim() === '') {
						const src = getImageSrc(node, state);
						const alt = getImageAlt(node, state);
						const width = getImageWidth(node, state);
						const height = getImageHeight(node, state);

						if (src) {
							const isLastLine = lineTo.number === state.doc.lines;
							return Decoration.widget({
								widget: new ImageWidget(context, src, alt, width, height, imageToRefreshCounters.get(src) ?? 0),
								side: isLastLine ? 1 : -1,
								block: true,
							});
						}
					}
				}
			}
			return null;
		},
		getDecorationRange: (node, state) => {
			const nodeLine = state.doc.lineAt(node.to);
			return [Math.min(nodeLine.to + 1, state.doc.length)];
		},
		hideWhenContainsSelection: false,

		shouldFullReRender: (transaction: Transaction) => {
			let hadRefreshEffect = false;
			for (const effect of transaction.effects) {
				if (effect.is(resetImageResourceEffect)) {
					const key = `:/${effect.value.id}`;
					imageToRefreshCounters.set(key, (imageToRefreshCounters.get(key) ?? 0) + 1);
					hadRefreshEffect = true;
				}
			}
			return hadRefreshEffect;
		},
	}),
];

export default renderBlockImages;
