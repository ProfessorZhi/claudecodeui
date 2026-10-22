import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import { readVoiceConfig, resetVoiceConfig } from '@/shared/voiceConfig';

/**
 * D1's settings surface: the recording switch (default ON), the capacity box, and the clear button
 * that asks before it deletes everything.
 *
 * THREE READINGS, each taken off what the form actually did rather than off its markup. The first
 * is that a user who saved nothing still sees the recording switch ON — the D1 default, read off
 * the switch's own state rather than off a label. The second is that turning it off reaches the
 * SAVED DOCUMENT: the settings are one whole document, so a switch whose value never made it into
 * the debounced save would be a control that looks like it works and changes nothing on the
 * server. The third is that the clear button does not call the endpoint on the first click — the
 * secondary confirmation the criterion names — and does once it is confirmed, reporting the count
 * the server answered with.
 *
 * The api module is replaced wholesale, so no case here touches the network; the settings store
 * itself is the real one, reset per case so no case inherits the previous one's document.
 */

const voice = vi.hoisted(() => ({
  health: vi.fn(),
  config: vi.fn(),
  saveConfig: vi.fn(),
  clearData: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: { voice }, authenticatedFetch: vi.fn() }));

// The tab's own enable switch is not what any reading here is about, and it gates the section
// below: pinned on so the data section renders. The toggle under test is the one named
// `voiceSettings.dataRecording`.
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ voiceEnabled: true }),
  useSetUiPreference: () => () => {},
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal() as object),
  // The key itself is the readable label here, with the interpolation appended when one is passed,
  // so a case can assert both that the right key rendered and that the count reached the message.
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options && typeof options.count === 'number' ? `${key}:${options.count}` : key,
  }),
}));

const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

/** The empty document the server answers with: nothing saved yet, so the defaults apply. */
const EMPTY_SERVER_DOCUMENT = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

/** The recording toggle, named by the stored field it edits through its aria label. */
const recordingToggle = (view: ReturnType<typeof render>): HTMLElement =>
  view.getByRole('switch', { name: 'voiceSettings.dataRecording' });

beforeEach(() => {
  voice.health.mockReset();
  voice.config.mockReset();
  voice.saveConfig.mockReset();
  voice.clearData.mockReset();
  // The settings module is a singleton for the whole tab; resetting it re-hydrates from the mocked
  // server so every case starts from the same empty document.
  resetVoiceConfig();
  voice.health.mockImplementation(() => ok({ configured: true, provider: 'alpha-asr', providers: [] }));
  voice.config.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
  voice.saveConfig.mockImplementation(() => ok({ ...EMPTY_SERVER_DOCUMENT }));
  voice.clearData.mockImplementation(() => ok({ deleted: 0 }));
});

test('a user who saved nothing sees recording ON — the D1 default — and its committed ceiling', async () => {
  const view = render(<VoiceSettingsTab />);

  // Default ON, read off the switch's own state: the server answered with no `voiceDataRecording`
  // key at all, and absence means on rather than off.
  await waitFor(() => assert.equal(recordingToggle(view).getAttribute('aria-checked'), 'true'));

  const config = readVoiceConfig();
  assert.equal(config.voiceDataRecording, true, 'the store defaults recording to on');
  assert.equal(config.voiceDataMaxBytes, 2147483648, 'the capacity defaults to the store’s own 2 GiB');
});

test('turning recording off reaches the saved document', async () => {
  const view = render(<VoiceSettingsTab />);
  await waitFor(() => assert.equal(recordingToggle(view).getAttribute('aria-checked'), 'true'));

  fireEvent.click(recordingToggle(view));
  await waitFor(() => assert.equal(recordingToggle(view).getAttribute('aria-checked'), 'false'));

  // The save is debounced, so the document is read off the request the form really made.
  await waitFor(
    () => assert.ok(voice.saveConfig.mock.calls.length > 0, 'the form never sent the settings document'),
    { timeout: 4_000 },
  );
  const sent = voice.saveConfig.mock.calls[voice.saveConfig.mock.calls.length - 1][0] as Record<string, unknown>;
  assert.equal(sent.voiceDataRecording, false, 'the switch’s value is in the saved document');
  assert.equal(sent.voiceDataMaxBytes, 2147483648, 'the capacity travels with the rest of the document');
});

test('the clear button asks before it deletes, then reports the count the server answered', async () => {
  voice.clearData.mockImplementation(() => ok({ deleted: 4 }));

  const view = render(<VoiceSettingsTab />);
  await waitFor(() => assert.equal(recordingToggle(view).getAttribute('aria-checked'), 'true'));

  // The first click only arms the button: no request, and the confirm affordance is now on screen.
  const clearButton = view.getByText('voiceSettings.dataClear');
  assert.equal(view.queryByText('voiceSettings.dataClearConfirm'), null, 'nothing is asked to confirm yet');
  fireEvent.click(clearButton);
  assert.equal(voice.clearData.mock.calls.length, 0, 'the un-confirmed button must not delete anything');
  assert.ok(view.getByText('voiceSettings.dataClearConfirm'), 'the confirmation step is shown');

  // The confirmation is what sends the request, and the answer’s count is what the user is shown.
  fireEvent.click(view.getByText('voiceSettings.dataClearConfirm'));
  await waitFor(() => expect(voice.clearData).toHaveBeenCalledTimes(1));
  await waitFor(() => assert.ok(view.getByText('voiceSettings.dataCleared:4'), 'the count is reported'));
});
