import { DEFAULT_SFX_PREFERENCES } from '../config/AppPreferences.js';
import { appState } from '../state.svelte.js';

const SFX_SOURCES = {
  chat: '/sfx/pop-chat.mp3',
  staff: '/sfx/pop-staff.mp3',
  inbox: '/sfx/pop-inbox.mp3'
};

const audioCache = new Map();

function getAudio(name) {
  if (typeof Audio === 'undefined') return null;

  const src = SFX_SOURCES[name];
  if (!src) return null;

  if (!audioCache.has(name)) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audioCache.set(name, audio);
  }

  return audioCache.get(name);
}

function getSfxPreferences() {
  const sfx = appState.appPreferences?.general?.sfx;
  if (!sfx || typeof sfx !== 'object') {
    return DEFAULT_SFX_PREFERENCES;
  }

  const volume = Number(sfx.volume);
  return {
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_SFX_PREFERENCES.volume,
    chat: sfx.chat !== undefined ? !!sfx.chat : DEFAULT_SFX_PREFERENCES.chat,
    staff: sfx.staff !== undefined ? !!sfx.staff : DEFAULT_SFX_PREFERENCES.staff,
    inbox: sfx.inbox !== undefined ? !!sfx.inbox : DEFAULT_SFX_PREFERENCES.inbox
  };
}

export function playSfx(name) {
  const audio = getAudio(name);
  if (!audio) return;

  const preferences = getSfxPreferences();
  if (!preferences[name] || preferences.volume <= 0) return;

  try {
    audio.currentTime = 0;
    audio.volume = preferences.volume;
    const playPromise = audio.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {
        // Browsers may block audio until the first user gesture.
      });
    }
  } catch {
    // Audio should never interrupt message handling.
  }
}
