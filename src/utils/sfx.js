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

export function playSfx(name) {
  const audio = getAudio(name);
  if (!audio) return;

  try {
    audio.currentTime = 0;
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
