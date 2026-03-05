import { AppState, createAppDefaultWindowState } from './app.reducer';
import appReducer, { createAppDefaultState } from './app.reducer';

describe('app.reducer', () => {
	it('should default accessibilitySupportEnabled to false', () => {
		const state: AppState = createAppDefaultState({});
		expect(state.accessibilitySupportEnabled).toBe(false);
	});

	it('should handle ACCESSIBILITY_SUPPORT_SET', () => {
		const state: AppState = createAppDefaultState({});
		const newState = appReducer(state, {
			type: 'ACCESSIBILITY_SUPPORT_SET',
			value: true,
		});

		expect(newState.accessibilitySupportEnabled).toBe(true);
	});

	it('should handle DIALOG_OPEN', async () => {
		const state: AppState = createAppDefaultState({});

		let newState = appReducer(state, {
			type: 'DIALOG_OPEN',
			name: 'syncWizard',
		});

		expect(newState.dialogs.length).toBe(1);
		expect(newState.dialogs[0].name).toBe('syncWizard');

		expect(() => appReducer(newState, {
			type: 'DIALOG_OPEN',
			name: 'syncWizard',
		})).toThrow();

		newState = appReducer(newState, {
			type: 'DIALOG_CLOSE',
			name: 'syncWizard',
		});

		expect(newState.dialogs.length).toBe(0);

		expect(() => appReducer(newState, {
			type: 'DIALOG_CLOSE',
			name: 'syncWizard',
		})).toThrow();

		newState = appReducer(newState, {
			type: 'DIALOG_OPEN',
			name: 'syncWizard',
		});

		newState = appReducer(newState, {
			type: 'DIALOG_OPEN',
			name: 'setPassword',
		});

		expect(newState.dialogs).toEqual([
			{ name: 'syncWizard', props: {} },
			{ name: 'setPassword', props: {} },
		]);
	});

	it('showing a dialog in one window should hide dialogs with the same ID in background windows', () => {
		const state: AppState = {
			...createAppDefaultState({}),
			backgroundWindows: {
				testWindow: {
					...createAppDefaultWindowState(),
					windowId: 'testWindow',

					visibleDialogs: {
						testDialog: true,
					},
				},
			},
		};

		const newState = appReducer(state, {
			type: 'VISIBLE_DIALOGS_ADD',
			name: 'testDialog',
		});

		expect(newState.backgroundWindows.testWindow.visibleDialogs).toEqual({});
		expect(newState.visibleDialogs).toEqual({ testDialog: true });
	});

});
