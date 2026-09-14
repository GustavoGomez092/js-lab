import type { SettingsUpdateParams } from "@jslab/rpc-schema";
import { readSetting, type SettingKey, settingPatch } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";

type Api = Pick<MainApi, "updateSettings">;
type Patch = SettingsUpdateParams["patch"];

interface WriterState {
  /** The value last requested per key while its update is in flight, so a rapid second step builds on it. */
  requested: Map<SettingKey, { value: unknown }>;
  sent: number;
  applied: number;
}

const writers = new WeakMap<AppStore, WriterState>();

function stateFor(store: AppStore): WriterState {
  let state = writers.get(store);
  if (!state) {
    state = { requested: new Map(), sent: 0, applied: 0 };
    writers.set(store, state);
  }
  return state;
}

/**
 * Sends a settings patch through Main and applies the response, unless it is stale (FB-m6): a `settings.changed`
 * broadcast received while the request was in flight is the source of truth, and a response older than one already
 * applied is dropped.
 */
export async function writeSettings(store: AppStore, api: Api, patch: Patch): Promise<void> {
  const state = stateFor(store);
  const sequence = ++state.sent;
  const revision = store.getState().settingsRevision;
  const result = await api.updateSettings(patch);
  if (store.getState().settingsRevision !== revision || sequence < state.applied) return;
  state.applied = sequence;
  store.getState().updateSettings(result);
}

/**
 * Updates one setting from its current value (FB-m6, T15-m5). While an update of the same key is in flight, the next
 * value is computed from the last requested value rather than the store, so two quick ⌘= presses are two steps and a
 * double toggle flips twice.
 */
export async function writeSetting(
  store: AppStore,
  api: Api,
  key: SettingKey,
  compute: (current: unknown) => unknown,
): Promise<void> {
  const settings = store.getState().settings;
  if (!settings) return;
  const { requested } = stateFor(store);
  const inFlight = requested.get(key);
  const entry = { value: compute(inFlight ? inFlight.value : readSetting(settings, key)) };
  requested.set(key, entry);
  try {
    await writeSettings(store, api, settingPatch(key, entry.value) as Patch);
  } finally {
    if (requested.get(key) === entry) requested.delete(key);
  }
}
