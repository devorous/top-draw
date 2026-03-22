/**
 * ProfileDialog — Reusable vanilla JS user profile modal.
 * Works in both the main app and gallery (or any page).
 *
 * Usage:
 *   import { ProfileDialog } from './ui/ProfileDialog.js';
 *   const dialog = new ProfileDialog();
 *   dialog.show('username');
 */

const STYLES = `
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
  background: #1a1a1a;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  max-width: 400px;
  width: 100%;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: profileSlideUp 0.2s ease;
  font-family: 'Inter', -apple-system, sans-serif;
  color: #e8e2d5;
}

@keyframes profileSlideUp {
  from { transform: translateY(16px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.profile-dialog-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.profile-dialog-close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.4);
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
.profile-dialog-close:hover {
  color: #fff;
  background: rgba(255,255,255,0.1);
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

.profile-dialog-error {
  color: #e07070;
}

.profile-username {
  font-size: 1.5rem;
  font-weight: 400;
  margin: 0;
  letter-spacing: -0.02em;
}

.profile-meta {
  margin-top: 0.25rem;
  font-size: 0.82rem;
  color: rgba(255,255,255,0.4);
}

.profile-stats {
  display: flex;
  gap: 1.5rem;
  margin-top: 1.25rem;
  padding: 1rem;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
}

.profile-stat {
  text-align: center;
}
.profile-stat-value {
  font-size: 1.25rem;
  font-weight: 500;
  color: #fff;
}
.profile-stat-label {
  font-size: 0.72rem;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-top: 0.2rem;
}

.profile-recent {
  margin-top: 1.5rem;
}
.profile-recent-title {
  font-size: 0.82rem;
  color: rgba(255,255,255,0.4);
  margin-bottom: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.profile-recent-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}
.profile-recent-item {
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 4px;
  background: #121212;
  border: none;
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
.profile-recent-item:hover img {
  transform: scale(1.05);
}
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
  padding: 0.65rem 1rem;
  border: 1px solid rgba(255,255,255,0.08);
  background: none;
  color: rgba(255,255,255,0.6);
  font-family: inherit;
  font-size: 0.82rem;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
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
  font-weight: 500;
}
.profile-btn-primary:hover {
  background: #00f0c3;
  border-color: #00f0c3;
}
`;

export class ProfileDialog {
  constructor(options = {}) {
    this.onViewGallery = options.onViewGallery || null;
    this.onImageClick = options.onImageClick || null;
    this.galleryBaseUrl = options.galleryBaseUrl || '/gallery';
    this.apiBaseUrl = options.apiBaseUrl || '';

    this._backdrop = null;
    this._stylesInjected = false;
    this._boundKeydown = this._handleKeydown.bind(this);
  }

  _injectStyles() {
    if (this._stylesInjected) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  async show(username, { instant = false } = {}) {
    if (!username) return;

    this._injectStyles();
    this.close(); // Close any existing

    // Create backdrop
    this._backdrop = document.createElement('div');
    this._backdrop.className = 'profile-dialog-backdrop';
    if (instant) {
      this._backdrop.style.animation = 'none';
    }
    this._backdrop.innerHTML = `
      <div class="profile-dialog">
        <div class="profile-dialog-header">
          <span></span>
          <button class="profile-dialog-close" title="Close">&times;</button>
        </div>
        <div class="profile-dialog-body">
          <div class="profile-dialog-loading">Loading...</div>
        </div>
      </div>
    `;

    // Event listeners
    this._backdrop.addEventListener('click', (e) => {
      if (e.target === this._backdrop) this.close();
    });
    this._backdrop.querySelector('.profile-dialog-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', this._boundKeydown);

    document.body.appendChild(this._backdrop);
    document.body.style.overflow = 'hidden';

    // Fetch profile
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/users/${encodeURIComponent(username)}`);
      const data = await res.json();

      if (!res.ok) {
        this._renderError(data.error || 'Failed to load profile');
        return;
      }

      this._renderProfile(data);
    } catch (err) {
      this._renderError('Connection error');
    }
  }

  _renderError(message) {
    const body = this._backdrop?.querySelector('.profile-dialog-body');
    if (!body) return;
    body.innerHTML = `<div class="profile-dialog-error">${message}</div>`;
  }

  _renderProfile(data) {
    const body = this._backdrop?.querySelector('.profile-dialog-body');
    if (!body) return;

    const joinDate = new Date(data.createdAt).toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    // Store uploads data for click handler
    this._recentUploads = data.recentUploads;

    const recentHtml = data.recentUploads.length > 0
      ? data.recentUploads.map((item, idx) => `
          <button class="profile-recent-item" data-index="${idx}" title="${item.title || 'View'}">
            <img src="${item.thumbUrl}" alt="${item.title || 'artwork'}" loading="lazy">
          </button>
        `).join('')
      : '<div class="profile-recent-empty">No uploads yet</div>';

    body.innerHTML = `
      <h2 class="profile-username">${this._escapeHtml(data.username)}</h2>
      <div class="profile-meta">Joined ${joinDate}</div>

      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-value">${data.uploadCount}</div>
          <div class="profile-stat-label">Uploads</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${data.totalLikes}</div>
          <div class="profile-stat-label">Likes</div>
        </div>
      </div>

      <div class="profile-recent">
        <div class="profile-recent-title">Recent Uploads</div>
        <div class="profile-recent-grid">${recentHtml}</div>
      </div>

      <div class="profile-actions">
        <a href="${this.galleryBaseUrl}?author=${encodeURIComponent(data.username)}" class="profile-btn profile-btn-primary">
          View All Art
        </a>
      </div>
    `;

    // Handle recent image clicks
    body.querySelectorAll('.profile-recent-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const item = this._recentUploads[idx];
        if (item && this.onImageClick) {
          this.close();
          this.onImageClick(item);
        } else if (item) {
          // Fallback: navigate
          window.location.href = `${this.galleryBaseUrl}?id=${item.id}`;
        }
      });
    });

    // Handle gallery link click if callback provided
    if (this.onViewGallery) {
      const galleryLink = body.querySelector('.profile-btn-primary');
      galleryLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
        this.onViewGallery(data.username);
      });
    }
  }

  _handleKeydown(e) {
    if (e.key === 'Escape') {
      this.close();
    }
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  close() {
    if (this._backdrop) {
      this._backdrop.remove();
      this._backdrop = null;
      document.body.style.overflow = '';
      document.removeEventListener('keydown', this._boundKeydown);
    }
  }
}

// Export singleton for simple usage
export const profileDialog = new ProfileDialog();
