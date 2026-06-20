/**
 * @fileoverview Central registry for user badges shown next to usernames.
 *
 * Each badge defines its id, label, accent color, and an inline SVG string. Badges
 * are rendered with inline SVG (rather than CSS `mask: url(...)`) so they work
 * reliably across browser and Tauri webviews.
 *
 * Adding a new badge: drop an entry into `BADGES` below. The badge is then
 * available via `createBadgeElement('your-id')` and will render anywhere
 * `badgesForUser()` includes it.
 */

const DISCORD_SVG = `<svg viewBox="0 0 127.14 96.36" aria-hidden="true" focusable="false"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2.04a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2.04a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69c-6.27 0-11.44-5.73-11.44-12.77s5.06-12.78 11.44-12.78c6.43 0 11.55 5.78 11.44 12.78 0 7.04-5.06 12.77-11.44 12.77Zm42.24 0c-6.27 0-11.44-5.73-11.44-12.77s5.06-12.78 11.44-12.78c6.43 0 11.55 5.78 11.44 12.78 0 7.04-5.01 12.77-11.44 12.77Z"/></svg>`;

export const BADGES = Object.freeze({
  discord: {
    id: 'discord',
    label: 'Discord linked',
    color: '#5865f2',
    svg: DISCORD_SVG,
  },
  flock: {
    id: 'flock',
    label: 'Flock',
    img: '/images/flock.png',
    selectable: true,
  },
  pepper: {
    id: 'pepper',
    label: 'Pepper',
    img: '/images/pepper.png',
    selectable: true,
  },
});

// Sentinel stored in `selectedBadge` to mean "explicitly show nothing", as
// opposed to '' / unset which falls back to the automatic Discord badge.
export const BADGE_NONE = 'none';

/**
 * Whether a given badge id may be selected by `userData`. `discord` is only
 * offered to accounts that actually have Discord linked.
 */
function canSelectBadge(id, userData) {
  if (id === 'discord') return !!userData?.hasDiscord;
  return !!BADGES[id]?.selectable;
}

/**
 * The badge ids a user may pick in their profile, in display order. Discord is
 * included first when the account is linked, followed by the cosmetic badges.
 * @returns {Array<{id: string, label: string}>}
 */
export function badgePickerOptions(userData) {
  const out = [];
  if (userData?.hasDiscord) out.push({ id: 'discord', label: BADGES.discord.label });
  for (const def of Object.values(BADGES)) {
    if (def.selectable) out.push({ id: def.id, label: def.label });
  }
  return out;
}

/**
 * The single badge id currently displayed for a user (or '' for none). Driven
 * by their explicit `selectedBadge`, falling back to the automatic Discord
 * badge when nothing is chosen.
 * @returns {string}
 */
export function effectiveBadgeId(userData) {
  const selected = userData?.selectedBadge || '';
  if (selected === BADGE_NONE) return '';
  if (selected && BADGES[selected] && canSelectBadge(selected, userData)) return selected;
  if (userData?.hasDiscord) return 'discord';
  return '';
}

/**
 * Build a DOM element for a single badge.
 * @param {string} badgeId
 * @returns {HTMLSpanElement|null}
 */
export function createBadgeElement(badgeId) {
  const def = BADGES[badgeId];
  if (!def) return null;
  const el = document.createElement('span');
  el.className = `userBadge userBadge-${def.id}`;
  el.title = def.label;
  el.setAttribute('aria-label', def.label);
  if (def.color) el.style.color = def.color;
  if (def.img) {
    const img = document.createElement('img');
    img.src = def.img;
    img.alt = def.label;
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.innerHTML = def.svg;
  }
  return el;
}

/**
 * Resolve the badge ids to render next to a username. A user shows a single
 * badge: their chosen `selectedBadge`, falling back to the automatic Discord
 * badge when nothing is picked. Returned as an array so render helpers stay
 * uniform.
 * @param {object} userData
 * @returns {string[]}
 */
export function badgesForUser(userData) {
  const id = effectiveBadgeId(userData);
  return id ? [id] : [];
}

/**
 * Build a container element with all of the user's badges. If the user has no
 * badges, the container is still returned (display:none) so callers can keep a
 * stable reference for later updates.
 * @param {object} userData
 * @returns {HTMLSpanElement}
 */
export function createUserBadgesContainer(userData) {
  const container = document.createElement('span');
  container.className = 'userBadges';
  renderBadgesInto(container, badgesForUser(userData));
  return container;
}

/**
 * Replace the contents of a container with the given badge ids.
 * @param {HTMLElement} container
 * @param {string[]} badgeIds
 */
export function renderBadgesInto(container, badgeIds) {
  if (!container) return;
  container.textContent = '';
  const ids = Array.isArray(badgeIds) ? badgeIds : [];
  for (const id of ids) {
    const el = createBadgeElement(id);
    if (el) container.appendChild(el);
  }
  container.style.display = container.childElementCount > 0 ? '' : 'none';
}
