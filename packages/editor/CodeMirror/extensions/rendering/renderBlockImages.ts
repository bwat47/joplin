import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { SyntaxNodeRef } from '@lezer/common';
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { RenderedContentContext } from './types';
import makeBlockReplaceExtension from './utils/makeBlockReplaceExtension';

const imageClassName = 'cm-md-image';
const imageLoadingClassName = 'cm-md-image-loading';
// Pre-set the image height for performance (allows CodeMirror to better calculate
// the document height while scrolling). This is just an estimate - actual images
// will scale to their natural size.
const estimatedImageHeight = 200;

interface ImageLoadState {
	loaded: boolean;
	naturalWidth?: number;
	naturalHeight?: number;
}

// Effect to mark an image as loaded with its natural dimensions
const imageLoadedEffect = StateEffect.define<{
	src: string;
	naturalWidth: number;
	naturalHeight: number;
}>();

// StateField to track which images have loaded
const imageLoadStateField = StateField.define<Map<string, ImageLoadState>>({
	create: () => new Map(),
	update: (state, transaction) => {
		let hasChanges = false;
		const newState = new Map(state);

		for (const effect of transaction.effects) {
			if (effect.is(imageLoadedEffect)) {
				const { src, naturalWidth, naturalHeight } = effect.value;
				newState.set(src, {
					loaded: true,
					naturalWidth,
					naturalHeight,
				});
				hasChanges = true;
			}
		}

		return hasChanges ? newState : state;
	},
});

class ImageWidget extends WidgetType {
	private resolvedSrc_: string;

	private readonly parsedWidthPx_: number | null;
	private readonly parsedHeightPx_: number | null;
	private readonly hasDimensions_: boolean;

	public constructor(
		private readonly context_: RenderedContentContext,
		private readonly src_: string,
		private readonly alt_: string,
		private readonly width_?: string,
		private readonly height_?: string,
		private readonly reloadCounter_ = 0,
		private readonly isLoaded_ = false,
	) {
		super();

		this.parsedWidthPx_ = ImageWidget.parsePixelSize_(this.width_);
		this.parsedHeightPx_ = ImageWidget.parsePixelSize_(this.height_);
		this.hasDimensions_ = this.parsedWidthPx_ !== null && this.parsedHeightPx_ !== null;
	}

	public eq(other: ImageWidget) {
		return this.src_ === other.src_ && this.alt_ === other.alt_ &&
			this.width_ === other.width_ && this.height_ === other.height_ &&
			this.reloadCounter_ === other.reloadCounter_ &&
			this.isLoaded_ === other.isLoaded_;
	}

	public updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const image = dom.querySelector<HTMLImageElement>('img.image');
		if (!image) return false;

		// If we don't have dimensions and the image isn't loaded yet,
		// render a minimal placeholder
		if (!this.hasDimensions_ && !this.isLoaded_) {
			image.alt = this.alt_;
			image.style.display = 'inline';
			image.style.width = '0';
			image.style.height = '0';
			image.style.opacity = '0';
			image.removeAttribute('width');
			image.removeAttribute('height');

			// Set up load handler to trigger re-render
			if (!this.resolvedSrc_) {
				void (async () => {
					this.resolvedSrc_ = await this.context_.resolveImageSrc(this.src_, this.reloadCounter_);
					image.src = this.resolvedSrc_;

					image.onload = () => {
						view.dispatch({
							effects: imageLoadedEffect.of({
								src: this.src_,
								naturalWidth: image.naturalWidth,
								naturalHeight: image.naturalHeight,
							}),
						});
					};
				})();
			} else {
				image.src = this.resolvedSrc_;
			}

			return true;
		}

		// Normal rendering for images with dimensions or after load
		image.alt = this.alt_;
		image.style.display = 'block';
		image.style.opacity = '1';
		image.removeAttribute('width');
		image.removeAttribute('height');
		image.style.maxWidth = '';
		image.style.maxHeight = '';
		image.style.width = '';
		image.style.height = '';

		if (this.parsedWidthPx_ !== null && this.parsedHeightPx_ !== null) {
			// Use HTML attributes to set intrinsic aspect ratio.
			// The browser will maintain this ratio even as the image scales.
			image.width = this.parsedWidthPx_;
			image.height = this.parsedHeightPx_;

			// CSS to make it responsive: limit width but let height scale automatically.
			// Don't set width:auto - let the HTML width attribute control the base size.
			image.style.maxWidth = '100%';
			image.style.height = 'auto';
		} else {
			const hasWidth = typeof this.width_ === 'string' && this.width_.trim() !== '';
			const hasHeight = typeof this.height_ === 'string' && this.height_.trim() !== '';

			if (hasWidth) {
				image.style.width = this.width_;
				image.style.maxWidth = '100%';
			} else {
				image.style.maxWidth = '100%';
			}

			if (hasHeight) {
				image.style.height = this.height_;
			} else if (hasWidth) {
				image.style.height = 'auto';
			}
		}

		image.style.maxHeight = 'none';

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

	public toDOM(view: EditorView) {
		const container = document.createElement('div');

		// Add appropriate class based on load state
		if (!this.hasDimensions_ && !this.isLoaded_) {
			container.classList.add(imageLoadingClassName);
		} else {
			container.classList.add(imageClassName);
		}

		const image = document.createElement('img');
		image.classList.add('image');

		container.appendChild(image);
		this.updateDOM(container, view);

		return container;
	}

	public get estimatedHeight() {
		// If we don't have dimensions and not loaded, return 0 (inline placeholder)
		if (!this.hasDimensions_ && !this.isLoaded_) {
			return 0;
		}

		// If height is specified, try to parse it for a better estimate
		if (this.parsedHeightPx_ !== null) {
			return this.parsedHeightPx_;
		}

		return estimatedImageHeight;
	}

	private static parsePixelSize_(value?: string) {
		if (!value) return null;

		const trimmed = value.trim();
		const match = trimmed.match(/^(\d+(?:\.\d+)?)(px)?$/i);
		if (!match) return null;

		return Number.parseFloat(match[1]);
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
	imageLoadStateField,
	EditorView.theme({
		[`& .${imageClassName}`]: {
			display: 'block',
			textAlign: 'center',
			margin: '0.5em 0',
			paddingLeft: '10px',
			paddingRight: '10px',
			maxWidth: '100%',
			boxSizing: 'border-box',
		},
		[`& .${imageClassName} > img`]: {
			maxWidth: '100%',
			height: 'auto',
			display: 'block',
			margin: '0 auto',
		},
		[`& .${imageLoadingClassName}`]: {
			display: 'inline',
			margin: '0',
			padding: '0',
		},
		[`& .${imageLoadingClassName} > img`]: {
			display: 'inline',
			width: '0',
			height: '0',
			opacity: '0',
		},
	}),
	makeBlockReplaceExtension({
		createDecoration: (node, state) => {
			const loadStateMap = state.field(imageLoadStateField);

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
						const loadState = loadStateMap.get(src);
						const isLoaded = loadState?.loaded ?? false;
						const isLastLine = lineTo.number === state.doc.lines;

						// For markdown images without dimensions, use inline widget until loaded
						const hasExplicitDimensions = false;
						const shouldBeBlock = hasExplicitDimensions || isLoaded;

						return Decoration.widget({
							widget: new ImageWidget(
								context,
								src,
								alt,
								undefined,
								undefined,
								imageToRefreshCounters.get(src) ?? 0,
								isLoaded,
							),
							// "side: -1": In general, when the cursor is at the widget's location, it should be at
							// the start of the next line (and so "side" should be -1).
							//
							// "side: 1": However, when the widget is at the end of the document, the widget's
							// position is **one index less** than when it isn't (to prevent the widget's
							// position from being outside the document, which would break CodeMirror).
							// This means that we need "side: 1" to put the cursor before the widget
							// when at the end of the document.
							side: isLastLine ? 1 : -1,
							block: shouldBeBlock,
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
							const loadState = loadStateMap.get(src);
							const isLoaded = loadState?.loaded ?? false;
							const isLastLine = lineTo.number === state.doc.lines;

							// Check if we have explicit dimensions from HTML attributes
							const hasExplicitDimensions = width !== null && height !== null;

							// Use block widget if we have dimensions or if loaded
							const shouldBeBlock = hasExplicitDimensions || isLoaded;

							return Decoration.widget({
								widget: new ImageWidget(
									context,
									src,
									alt,
									width,
									height,
									imageToRefreshCounters.get(src) ?? 0,
									isLoaded,
								),
								side: isLastLine ? 1 : -1,
								block: shouldBeBlock,
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
			let hadLoadEffect = false;

			for (const effect of transaction.effects) {
				if (effect.is(resetImageResourceEffect)) {
					const key = `:/${effect.value.id}`;
					imageToRefreshCounters.set(key, (imageToRefreshCounters.get(key) ?? 0) + 1);
					hadRefreshEffect = true;
				}
				if (effect.is(imageLoadedEffect)) {
					hadLoadEffect = true;
				}
			}

			return hadRefreshEffect || hadLoadEffect;
		},
	}),
];

export default renderBlockImages;
