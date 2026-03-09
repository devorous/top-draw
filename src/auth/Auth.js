/**
 * Auth module — handles token storage, login/register form logic, auto-login
 */
const TOKEN_KEY = 'topDrawAuthToken';
const REMEMBER_ME_KEY = 'topDrawRememberMe';
const USERNAME_KEY = 'topDrawUsername';

export class Auth {
  constructor({ wsClient, onSuccess, onError, onLoggedInStateChange }) {
    this.wsClient = wsClient;
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.onLoggedInStateChange = onLoggedInStateChange;

    // DOM elements (cached in init)
    this.els = {};

    // Current logged in state
    this.isLoggedIn = false;
    this.loggedInUsername = null;
  }

  init() {
    this.els = {
      // Login state elements
      authNotLoggedIn: document.getElementById('authNotLoggedIn'),
      authLoggedIn: document.getElementById('authLoggedIn'),
      authEditCredentials: document.getElementById('authEditCredentials'),
      // Not logged in form
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginJoinBtn: document.getElementById('loginJoinBtn'),
      rememberMe: document.getElementById('rememberMe'),
      // Logged in state
      authUsernameBtn: document.getElementById('authUsernameBtn'),
      authUsernameDisplay: document.getElementById('authUsernameDisplay'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
      // Edit credentials
      authEditClose: document.getElementById('authEditClose'),
      editUsername: document.getElementById('editUsername'),
      editPassword: document.getElementById('editPassword'),
      editLoginJoinBtn: document.getElementById('editLoginJoinBtn')
    };

    // Load remember me preference
    if (this.els.rememberMe) {
      this.els.rememberMe.checked = this.getRememberMe();
    }

    this.setupListeners();

    // Check if user has stored credentials for auto-login
    this.checkStoredLogin();
  }

  setupListeners() {
    // Dynamic button text based on password input
    this.els.loginPassword?.addEventListener('input', () => {
      this.updateButtonText(this.els.loginPassword, this.els.loginJoinBtn);
    });
    this.els.editPassword?.addEventListener('input', () => {
      this.updateButtonText(this.els.editPassword, this.els.editLoginJoinBtn);
    });

    // Consolidated buttons
    this.els.loginJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.els.loginPassword?.value) {
        this.handleLogin();
      } else {
        this.triggerJoin();
      }
    });

    this.els.joinBtnLoggedIn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.editLoginJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const newUsername = this.els.editUsername?.value.trim();
      
      if (this.els.editPassword?.value) {
        this.handleSaveCredentials();
      } else {
        // If user changed the username while logged in, log them out first
        if (this.isLoggedIn && newUsername && newUsername !== this.loggedInUsername) {
          this.logout();
          // Update the loginUsername field so App.handleJoin picks it up
          if (this.els.loginUsername) {
            this.els.loginUsername.value = newUsername;
          }
        }
        
        this.hideEditCredentials();
        this.triggerJoin();
      }
    });

    // Enter key on password fields
    this.els.loginPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.els.loginPassword?.value) {
          this.handleLogin();
        } else {
          this.triggerJoin();
        }
      }
    });

    this.els.editPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.els.editPassword?.value) {
          this.handleSaveCredentials();
        } else {
          this.hideEditCredentials();
          this.triggerJoin();
        }
      }
    });

    // Username button (logged in state) - opens edit panel
    this.els.authUsernameBtn?.addEventListener('click', () => this.showEditCredentials());

    // Edit credentials panel
    this.els.authEditClose?.addEventListener('click', () => this.hideEditCredentials());
  }

  /**
   * Manually trigger the join process via the form submit event
   */
  triggerJoin() {
    const form = document.getElementById('loginForm');
    if (form) {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }

  /**
   * Update button text based on whether password is provided
   */
  updateButtonText(passwordInput, buttonEl) {
    if (!buttonEl) return;
    buttonEl.textContent = passwordInput?.value ? 'Login' : 'Join';
  }

  /**
   * Check if user has stored login credentials
   */
  checkStoredLogin() {
    // We only auto-LOGIN if user enabled "Remember me"
    // This will update the UI to show they are logged in, 
    // but they still need to click JOIN to enter a room.
    if (this.getRememberMe() && this.getStoredToken()) {
      const storedUsername = this.getStoredUsername();
      if (storedUsername) {
        // Just show the logged-in UI state (username button, etc)
        // We don't call handleLogin or anything that auto-joins.
        this.showLoggedInState(storedUsername);
      }
    }
  }

  /**
   * Show the logged-in UI state
   */
  showLoggedInState(username) {
    this.isLoggedIn = true;
    this.loggedInUsername = username;

    if (this.els.authNotLoggedIn) this.els.authNotLoggedIn.style.display = 'none';
    if (this.els.authLoggedIn) this.els.authLoggedIn.style.display = 'flex';
    if (this.els.authEditCredentials) this.els.authEditCredentials.style.display = 'none';
    if (this.els.authUsernameDisplay) this.els.authUsernameDisplay.textContent = username;

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(true, username);
    }
  }

  /**
   * Show the not-logged-in UI state
   */
  showNotLoggedInState() {
    this.isLoggedIn = false;
    this.loggedInUsername = null;

    if (this.els.authNotLoggedIn) this.els.authNotLoggedIn.style.display = 'flex';
    if (this.els.authLoggedIn) this.els.authLoggedIn.style.display = 'none';
    if (this.els.authEditCredentials) this.els.authEditCredentials.style.display = 'none';

    // Reset button text
    this.updateButtonText(this.els.loginPassword, this.els.loginJoinBtn);

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(false, null);
    }
  }

  /**
   * Show the edit credentials panel
   */
  showEditCredentials() {
    if (this.els.authLoggedIn) this.els.authLoggedIn.style.display = 'none';
    if (this.els.authEditCredentials) this.els.authEditCredentials.style.display = 'flex';

    // Pre-fill username
    if (this.els.editUsername) {
      this.els.editUsername.value = this.loggedInUsername || '';
    }
    // Clear password fields
    if (this.els.editPassword) {
      this.els.editPassword.value = '';
    }
    
    // Reset button text
    this.updateButtonText(this.els.editPassword, this.els.editLoginJoinBtn);
  }

  /**
   * Hide the edit credentials panel, return to correct auth state
   */
  hideEditCredentials() {
    if (this.els.authEditCredentials) this.els.authEditCredentials.style.display = 'none';
    
    if (this.isLoggedIn) {
      if (this.els.authLoggedIn) this.els.authLoggedIn.style.display = 'flex';
    } else {
      if (this.els.authNotLoggedIn) this.els.authNotLoggedIn.style.display = 'flex';
    }
  }

  /**
   * Log out the current user (clear session/token)
   */
  logout() {
    this.clearToken();
    this.clearStoredUsername();
    this.setRememberMe(false);
    this.showNotLoggedInState();
  }

  /**
   * Handle switching account (login with new credentials)
   */
  handleSaveCredentials() {
    if (this._loading) return;

    const username = this.els.editUsername?.value.trim();
    const password = this.els.editPassword?.value;

    if (!username || !password) {
      if (this.onError) this.onError('Please enter username and password');
      return;
    }

    // Reuse handleLogin logic
    this._pendingUsername = username;
    this.setLoading(true);
    this.wsClient.sendAuthLogin(username, password);
  }

  handleLogin() {
    if (this._loading) return;

    const username = this.els.loginUsername?.value.trim();
    const password = this.els.loginPassword?.value;

    if (!username || !password) {
      if (this.onError) this.onError('Please enter username and password');
      return;
    }

    // Store username for display after login success
    this._pendingUsername = username;

    this.setLoading(true);
    this.wsClient.sendAuthLogin(username, password);
  }

  /**
   * Get the username to join with (used by App.handleJoin)
   */
  getJoinUsername() {
    if (this.isLoggedIn && this.loggedInUsername) {
      return this.loggedInUsername;
    }
    return this.els.loginUsername?.value.trim() || null;
  }

  handleRegister() {
    // Deprecated for now, we only use Join/Login
  }

  attemptAutoLogin() {
    // Only auto-login if user enabled "Remember me"
    if (!this.getRememberMe()) {
      return false;
    }

    const token = this.getStoredToken();
    if (token) {
      this.wsClient.sendAuthTokenLogin(token);
      return true;
    }
    return false;
  }

  handleAuthResult(data) {
    this.setLoading(false);

    if (data.success) {
      const username = data.username || this._pendingUsername;
      this._pendingUsername = null;

      if (data.token) {
        this.storeToken(data.token);
        // Store username for future display
        if (username) {
          this.storeUsername(username);
        }
        // Store remember me preference
        if (this.els.rememberMe?.checked) {
          this.setRememberMe(true);
        }
      }

      // Show logged-in state on landing page
      if (username) {
        this.showLoggedInState(username);
      }

      if (this.onSuccess) {
        this.onSuccess(data.token, data.role, username);
      }
    } else {
      this._pendingUsername = null;

      // If auto-login failed, clear the invalid token and remember me preference
      if (this.getStoredToken()) {
        this.clearToken();
        this.clearStoredUsername();
        this.setRememberMe(false);
        this.showNotLoggedInState();
      }

      const errorMessage = data.error || 'Authentication failed';

      if (this.onError) {
        this.onError(errorMessage);
      }
    }
  }

  setLoading(loading) {
    this._loading = loading;
    const btns = [this.els.loginJoinBtn, this.els.editLoginJoinBtn];

    if (loading) {
      btns.forEach(btn => {
        if (btn) {
          btn._oldText = btn.textContent;
          btn.textContent = '...';
          btn.classList.add('disabled');
        }
      });
      // Safety timeout — reset after 10s if server never responds
      this._loadingTimeout = setTimeout(() => {
        this.setLoading(false);
        if (this.onError) this.onError('No response from server');
      }, 10000);
    } else {
      if (this._loadingTimeout) { clearTimeout(this._loadingTimeout); this._loadingTimeout = null; }
      btns.forEach(btn => {
        if (btn) {
          btn.textContent = btn._oldText || 'Join';
          btn.classList.remove('disabled');
        }
      });
    }
  }

  // Token storage
  storeToken(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch { /* ignore */ }
  }

  getStoredToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
  }

  // Remember me preference
  getRememberMe() {
    try {
      return localStorage.getItem(REMEMBER_ME_KEY) === 'true';
    } catch {
      return false;
    }
  }

  setRememberMe(value) {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, value ? 'true' : 'false');
    } catch { /* ignore */ }
  }

  // Username storage (for displaying logged-in state)
  storeUsername(username) {
    try {
      localStorage.setItem(USERNAME_KEY, username);
    } catch { /* ignore */ }
  }

  getStoredUsername() {
    try {
      return localStorage.getItem(USERNAME_KEY);
    } catch {
      return null;
    }
  }

  clearStoredUsername() {
    try {
      localStorage.removeItem(USERNAME_KEY);
    } catch { /* ignore */ }
  }
}
