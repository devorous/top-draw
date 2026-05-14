/**
 * ProfileDialog — Reusable vanilla JS user profile modal.
 * Works in both the main app and gallery (or any page).
 */

const PX_PER_METER = 3779;
const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble Mod', 'Holy Mod', 'Deity Mod'];
const AVATAR_TARGET_PX = 256;
const AVATAR_QUALITY = 0.82;

const STYLES = `
:root {
  --role-noble: #ba95ff;
  --role-holy:  #ffa0ae;
  --role-deity: #dd8d4d;
}

.profile-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  backdrop-filter: blur(4px);
  animation: profileFadeIn 0.15s ease;
}

@keyframes profileFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.profile-dialog {
  position: relative;
  background: linear-gradient(180deg, #1c1c1f 0%, #141416 100%);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  max-width: 440px;
  width: 100%;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: profileSlideUp 0.2s ease;
  font-family: 'Inter', -apple-system, sans-serif;
  color: #e8e2d5;
  box-shadow: 0 24px 60px rgba(0,0,0,0.5);
}

@keyframes profileSlideUp {
  from { transform: translateY(16px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.profile-dialog-close {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 2;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.6);
  font-size: 1.5rem;
  cursor: pointer;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.profile-dialog-close:hover {
  background: rgba(255,255,255,0.1);
  color: #fff;
}

.profile-dialog-body {
  padding: 1.5rem;
  overflow-y: auto;
}

.profile-dialog-loading,
.profile-dialog-error {
  text-align: center;
  padding: 2rem;
  color: rgba(255,255,255,0.5);
}
.profile-dialog-error { color: #e07070; }

.profile-header {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.profile-avatar-wrap { position: relative; flex-shrink: 0; }

.profile-avatar {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  overflow: hidden;
}
.profile-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.profile-avatar-initial {
  font-size: 2.2rem;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 2px 4px rgba(0,0,0,0.4);
  line-height: 1;
}

.profile-avatar.rank-noble {
  border-color: var(--role-noble);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 16px color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-avatar.rank-holy {
  border-color: var(--role-holy);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 20px color-mix(in srgb, var(--role-holy), transparent 50%);
}
.profile-avatar.rank-deity {
  border-color: var(--role-deity);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3),
              0 0 24px color-mix(in srgb, var(--role-deity), transparent 35%);
}

.profile-avatar-edit {
  position: absolute;
  bottom: -4px;
  right: -4px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #0c0c0e;
  border: 1px solid rgba(255,255,255,0.2);
  color: #fff;
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  transition: background 0.15s, transform 0.15s;
}
.profile-avatar-edit:hover:not(:disabled) {
  background: #1f1f24;
  transform: scale(1.08);
}
.profile-avatar-edit:disabled { opacity: 0.5; cursor: wait; }

.profile-identity { min-width: 0; flex: 1; }

.profile-username {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #fff;
}
.profile-username.rank-noble {
  color: var(--role-noble);
  text-shadow: 0 0 8px color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-username.rank-holy {
  color: var(--role-holy);
  text-shadow: 0 0 10px color-mix(in srgb, var(--role-holy), transparent 50%);
}
.profile-username.rank-deity {
  color: var(--role-deity);
  text-shadow: 0 0 12px color-mix(in srgb, var(--role-deity), transparent 35%);
  animation: deityShimmer 4s ease-in-out infinite;
}

@keyframes deityShimmer {
  0%, 100% { text-shadow: 0 0 10px color-mix(in srgb, var(--role-deity), transparent 40%); }
  50%      { text-shadow: 0 0 18px color-mix(in srgb, var(--role-deity), transparent 20%); }
}

.profile-role-row {
  margin-top: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.profile-role-badge {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.7);
  border: 1px solid rgba(255,255,255,0.08);
}
.profile-role-badge.rank-noble {
  color: var(--role-noble);
  background: color-mix(in srgb, var(--role-noble), transparent 85%);
  border-color: color-mix(in srgb, var(--role-noble), transparent 60%);
}
.profile-role-badge.rank-holy {
  color: var(--role-holy);
  background: color-mix(in srgb, var(--role-holy), transparent 85%);
  border-color: color-mix(in srgb, var(--role-holy), transparent 60%);
}
.profile-role-badge.rank-deity {
  color: var(--role-deity);
  background: color-mix(in srgb, var(--role-deity), transparent 80%);
  border-color: color-mix(in srgb, var(--role-deity), transparent 50%);
}

.profile-meta { font-size: 0.78rem; color: rgba(255,255,255,0.4); }

.profile-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
  margin-top: 1.25rem;
}
.profile-stat {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 0.75rem 0.5rem;
  text-align: center;
  transition: background 0.15s, border-color 0.15s;
}
.profile-stat:hover {
  background: rgba(255,255,255,0.06);
  border-color: rgba(255,255,255,0.1);
}
.profile-stat-value {
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.profile-stat-label {
  font-size: 0.65rem;
  color: rgba(255,255,255,0.45);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 0.35rem;
}

.profile-recent { margin-top: 1.5rem; }
.profile-recent-title {
  font-size: 0.72rem;
  color: rgba(255,255,255,0.4);
  margin-bottom: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.profile-recent-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}
.profile-recent-item {
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 6px;
  background: #121212;
  border: 1px solid rgba(255,255,255,0.04);
  padding: 0;
  cursor: pointer;
}
.profile-recent-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.2s;
}
.profile-recent-item:hover img { transform: scale(1.05); }
.profile-recent-empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 1rem;
  color: rgba(255,255,255,0.3);
  font-size: 0.82rem;
}

.profile-actions {
  margin-top: 1.25rem;
  display: flex;
  gap: 0.75rem;
}
.profile-btn {
  flex: 1;
  padding: 0.7rem 1rem;
  border: 1px solid rgba(255,255,255,0.08);
  background: none;
  color: rgba(255,255,255,0.6);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
  text-decoration: none;
  text-align: center;
}
.profile-btn:hover {
  border-color: rgba(255,255,255,0.2);
  color: #fff;
}
.profile-btn-primary {
  background: #00d4aa;
  border-color: #00d4aa;
  color: #121212;
}
.profile-btn-primary:hover {
  background: #00f0c3;
  border-color: #00f0c3;
}

.profile-avatar-remove {
  margin-top: 0.4rem;
  background: none;
  border: none;
  color: rgba(224,112,112,0.85);
  font-size: 0.72rem;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-decoration-color: rgba(224,112,112,0.3);
}
.profile-avatar-remove:hover { color: #ff8585; }
.profile-avatar-remove:disabled { opacity: 0.5; cursor: wait; }

.profile-edit-error {
  margin-top: 0.75rem;
  font-size: 0.75rem;
  color: #e07070;
  text-align: center;
}
`;

function rankClass(role) {
  if (role >= 9) return 'rank-deity';
  if (role >= 8) return 'rank-holy';
  if (role >= 7) return 'rank-noble';
  if (role >= 5) return 'rank-admin';
  if (role >= 4) return 'rank-mod';
  if (role >= 3) return 'rank-helper';
  if (role >= 2) return 'rank-trusted';
  if (role >= 1) return 'rank-user';
  return 'rank-guest';
}

function roleName(role) {
  return ROLE_NAMES[Math.max(0, Math.min(9, role | 0))] || 'User';
}

function avatarInitial(name) {
  if (!name) return '?';
  return [...name][0].toUpperCase();
}

function avatarHue(name) {
  if (!name) return 200;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function formatMeters(px) {
  const m = (px || 0) / PX_PER_METER;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 1) return `${m.toFixed(1)} m`;
  return `${(m * 100).toFixed(0)} cm`;
}

function formatTime(ms) {
  const totalMin = Math.floor((ms || 0) / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function formatNumber(n) { return (n || 0).toLocaleString(); }

function resizeImageToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
      try { resolve(canvas.toDataURL('image/jpeg', quality)); }
      catch (err) { reject(err); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}

export class ProfileDialog {
  constructor(options = {}) {
    this.onViewGallery = options.onViewGallery || null;
    this.onImageClick = options.onImageClick || null;
    this.galleryBaseUrl = options.galleryBaseUrl || '/gallery';
    this.apiBaseUrl = options.apiBaseUrl || '';

    this._backdrop = null;
    this._stylesInjected = false;
    this._boundKeydown = this._handleKeydown.bind(this);
    this._data = null;
    this._savingAvatar = false;
    this._editError = '';
  }

  _buildGalleryUrl(pathSegment) {
    const base = String(this.galleryBaseUrl || '/gallery').replace(/\/$/, '');
    return `${base}/${encodeURIComponent(pathSegment)}`;
  }

  _injectStyles() {
    if (this._stylesInjected) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  _getAuthToken() {
    try { return localStorage.getItem('topDrawAuthToken') || ''; }
    catch { return ''; }
  }

  async show(username, { instant = false } = {}) {
    if (!username) return;

    this._injectStyles();
    this.close();
    this._editError = '';

    this._backdrop = document.createElement('div');
    this._backdrop.className = 'profile-dialog-backdrop';
    if (instant) this._backdrop.style.animation = 'none';
    this._backdrop.innerHTML = `
      <div class="profile-dialog">
        <button class="profile-dialog-close" title="Close">&times;</button>
        <div class="profile-dialog-body">
          <div class="profile-dialog-loading">Loading...</div>
        </div>
      </div>
    `;

    this._backdrop.addEventListener('click', (e) => {
      if (e.target === this._backdrop) this.close();
    });
    this._backdrop.querySelector('.profile-dialog-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', this._boundKeydown);

    document.body.appendChild(this._backdrop);
    document.body.style.overflow = 'hidden';

    try {
      const token = this._getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${this.apiBaseUrl}/api/users/${encodeURIComponent(username)}`, { headers });
      const data = await res.json();

      if (!res.ok) {
        this._renderError(data.error || 'Failed to load profile');
        return;
      }

      this._data = data;
      this._renderProfile();
    } catch (err) {
      this._renderError('Connection error');
    }
  }

  _renderError(message) {
    const body = this._backdrop?.querySelector('.profile-dialog-body');
    if (!body) return;
    body.innerHTML = `<div class="profile-dialog-error">${this._escapeHtml(message)}</div>`;
  }

  _renderProfile() {
    const body = this._backdrop?.querySelector('.profile-dialog-body');
    if (!body || !this._data) return;
    const data = this._data;

    const role = data.role || 1;
    const rcls = rankClass(role);
    const hue = avatarHue(data.username);
    const initial = this._escapeHtml(avatarInitial(data.username));
    const isOwn = !!data.isOwn;

    const joinMeta = data.createdAt
      ? `<span class="profile-meta">Joined ${new Date(data.createdAt).toLocaleDateString('en-CA', {
          year: 'numeric', month: 'short', day: 'numeric'
        })}</span>`
      : '';

    this._recentUploads = data.recentUploads;

    const recentHtml = data.recentUploads.length > 0
      ? data.recentUploads.map((item, idx) => `
          <button class="profile-recent-item" data-index="${idx}" title="${this._escapeHtml(item.title || 'View')}">
            <img src="${item.thumbUrl}" alt="${this._escapeHtml(item.title || 'artwork')}" loading="lazy">
          </button>
        `).join('')
      : '<div class="profile-recent-empty">No uploads yet</div>';

    const streakStat = (data.consecutiveDaysDrawn || 0) > 0
      ? `<div class="profile-stat">
           <div class="profile-stat-value">${formatNumber(data.consecutiveDaysDrawn)}</div>
           <div class="profile-stat-label">Day Streak</div>
         </div>`
      : '';

    const avatarBg = `background: linear-gradient(135deg, hsl(${hue}, 65%, 48%) 0%, hsl(${(hue + 35) % 360}, 70%, 35%) 100%);`;
    const avatarInner = data.avatar
      ? `<img class="profile-avatar-img" src="${data.avatar}" alt="avatar">`
      : `<span class="profile-avatar-initial">${initial}</span>`;

    const avatarEditBtn = isOwn
      ? `<button class="profile-avatar-edit" data-action="edit-avatar" title="Change avatar" aria-label="Change avatar"${this._savingAvatar ? ' disabled' : ''}>${this._savingAvatar ? '…' : '✎'}</button>
         <input type="file" data-input="avatar" accept="image/*" style="display:none">`
      : '';

    const removeAvatarBtn = (isOwn && data.avatar)
      ? `<button class="profile-avatar-remove" data-action="remove-avatar"${this._savingAvatar ? ' disabled' : ''}>Remove avatar</button>`
      : '';

    const errHtml = this._editError
      ? `<div class="profile-edit-error">${this._escapeHtml(this._editError)}</div>`
      : '';

    body.innerHTML = `
      <div class="profile-header">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar ${rcls}" style="${avatarBg}">${avatarInner}</div>
          ${avatarEditBtn}
        </div>
        <div class="profile-identity">
          <h2 class="profile-username ${rcls}">${this._escapeHtml(data.username)}</h2>
          <div class="profile-role-row">
            <span class="profile-role-badge ${rcls}">${roleName(role)}</span>
            ${joinMeta}
          </div>
          ${removeAvatarBtn}
        </div>
      </div>

      ${errHtml}

      <div class="profile-stats-grid">
        <div class="profile-stat">
          <div class="profile-stat-value">${formatMeters(data.distanceDrawn)}</div>
          <div class="profile-stat-label">Distance Drawn</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatTime(data.timeSpentMs)}</div>
          <div class="profile-stat-label">Time Drawing</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.totalStrokes)}</div>
          <div class="profile-stat-label">Strokes</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.uploadCount)}</div>
          <div class="profile-stat-label">Uploads</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${formatNumber(data.totalLikes)}</div>
          <div class="profile-stat-label">Likes</div>
        </div>
        ${streakStat}
      </div>

      <div class="profile-recent">
        <div class="profile-recent-title">Recent Uploads</div>
        <div class="profile-recent-grid">${recentHtml}</div>
      </div>

      <div class="profile-actions">
        <a href="${this._buildGalleryUrl(data.username)}" class="profile-btn profile-btn-primary" target="_blank">
          View on Gallery
        </a>
      </div>
    `;

    body.querySelectorAll('.profile-recent-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const item = this._recentUploads[idx];
        if (item && this.onImageClick) {
          this.close();
          this.onImageClick(item);
        } else if (item) {
          window.open(this._buildGalleryUrl(item.id), '_blank');
        }
      });
    });

    if (this.onViewGallery) {
      const galleryLink = body.querySelector('.profile-btn-primary');
      galleryLink?.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
        this.onViewGallery(data.username);
      });
    }

    this._wireEditing(body);
  }

  _wireEditing(root) {
    const editAvatar = root.querySelector('[data-action="edit-avatar"]');
    const fileInput = root.querySelector('[data-input="avatar"]');
    if (editAvatar && fileInput) {
      editAvatar.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => this._handleAvatarFile(e));
    }

    const removeAvatar = root.querySelector('[data-action="remove-avatar"]');
    if (removeAvatar) removeAvatar.addEventListener('click', () => this._removeAvatar());
  }

  async _handleAvatarFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this._editError = 'Select an image file';
      this._renderProfile();
      return;
    }
    if (this._savingAvatar) return;
    this._savingAvatar = true;
    this._editError = '';
    this._renderProfile();
    try {
      const dataUrl = await resizeImageToDataUrl(file, AVATAR_TARGET_PX, AVATAR_QUALITY);
      const updated = await this._patchProfile({ avatar: dataUrl });
      this._data.avatar = updated.avatar ?? dataUrl;
    } catch (err) {
      this._editError = err?.message || 'Failed to upload';
    } finally {
      this._savingAvatar = false;
      this._renderProfile();
    }
  }

  async _removeAvatar() {
    if (this._savingAvatar) return;
    this._savingAvatar = true;
    this._editError = '';
    this._renderProfile();
    try {
      await this._patchProfile({ avatar: null });
      this._data.avatar = null;
    } catch (err) {
      this._editError = err?.message || 'Failed to remove';
    } finally {
      this._savingAvatar = false;
      this._renderProfile();
    }
  }

  async _patchProfile(body) {
    const token = this._getAuthToken();
    if (!token) throw new Error('Not signed in');
    const res = await fetch(`${this.apiBaseUrl}/api/users/me/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Save failed');
    return json;
  }

  _handleKeydown(e) {
    if (e.key === 'Escape') this.close();
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  close() {
    if (this._backdrop) {
      this._backdrop.remove();
      this._backdrop = null;
      document.body.style.overflow = '';
      document.removeEventListener('keydown', this._boundKeydown);
    }
    this._data = null;
  }
}

export const profileDialog = new ProfileDialog();
