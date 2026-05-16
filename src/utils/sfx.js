import { DEFAULT_SFX_PREFERENCES } from '../config/AppPreferences.js';
import { appState } from '../state.svelte.js';

const SFX_SOURCES = {
  chat: '/sfx/pop-chat.mp3',
  staff: '/sfx/pop-staff.mp3',
  inbox: '/sfx/pop-inbox.mp3'
};

const audioCache = new Map();
let sfxPrimed = false;
let sfxPriming = false;

function getAudio(name) {
  if (typeof Audio === 'undefined') return null;

  const src = SFX_SOURCES[name];
  if (!src) return null;

  if (!audioCache.has(name)) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.load();
    audioCache.set(name, audio);
  }

  return audioCache.get(name);
}

function restorePrimedAudio(audio, muted, volume) {
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.muted = muted;
    audio.volume = volume;
  } catch {
    // Best effort only; priming should not affect normal app startup.
  }
}

function primeSfxPlayback() {
  if (sfxPrimed || sfxPriming) return;
  sfxPriming = true;

  const primePromises = Object.keys(SFX_SOURCES).map((name) => {
    const audio = getAudio(name);
    if (!audio) return Promise.resolve();

    const muted = audio.muted;
    const volume = audio.volume;

    try {
      audio.muted = true;
      audio.volume = 0;
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise?.then) {
        return playPromise
          .catch(() => {})
          .finally(() => restorePrimedAudio(audio, muted, volume));
      }
    } catch {
      // Ignore and let a later explicit notification attempt try again.
    }

    restorePrimedAudio(audio, muted, volume);
    return Promise.resolve();
  });

  Promise.allSettled(primePromises).finally(() => {
    sfxPrimed = true;
    sfxPriming = false;
  });
}

function installSfxPrimer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const primeAndRemove = () => {
    primeSfxPlayback();
    for (const eventName of ['pointerdown', 'keydown', 'touchend', 'mousedown']) {
      window.removeEventListener(eventName, primeAndRemove, true);
    }
  };

  for (const eventName of ['pointerdown', 'keydown', 'touchend', 'mousedown']) {
    window.addEventListener(eventName, primeAndRemove, { capture: true, passive: true });
  }
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

installSfxPrimer();
