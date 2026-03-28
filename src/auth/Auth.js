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
      editLoginJoinBtn: document.getElementById('editLoginJoinBtn'),
      // Registration
      registerBtn: document.getElementById('registerBtn'),
      registerPanel: document.getElementById('authRegisterPanel'),
      registerClose: document.getElementById('registerClose'),
      registerUsername: document.getElementById('registerUsername'),
      registerPassword: document.getElementById('registerPassword'),
      registerEmail: document.getElementById('registerEmail'),
      registerSecretQuestion: document.getElementById('registerSecretQuestion'),
      registerSecretAnswer: document.getElementById('registerSecretAnswer'),
      registerSubmitBtn: document.getElementById('registerSubmitBtn'),
      roomIdInput: document.getElementById('roomIdInput')
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
    // Dynamic button text and register button visibility based on password input
    this.els.loginPassword?.addEventListener('input', () => {
      this.updateButtonText(this.els.loginPassword, this.els.loginJoinBtn);
      // Show register button when password is entered
      if (this.els.registerBtn) {
        this.els.registerBtn.style.display = this.els.loginPassword.value ? '' : 'none';
      }
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

    // Register button — opens registration panel
    this.els.registerBtn?.addEventListener('click', () => this.showRegisterPanel());
    this.els.registerClose?.addEventListener('click', () => this.hideRegisterPanel());
    this.els.registerSubmitBtn?.addEventListener('click', () => this.handleRegister());
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
    // Show logged-in UI if we have a stored token and username
    if (this.getStoredToken()) {
      const storedUsername = this.getStoredUsername();
      if (storedUsername) {
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

    if (!this.wsClient?.connected) {
      if (this.onError) this.onError('Not currently connected');
      return;
    }

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

    if (!this.wsClient?.connected) {
      if (this.onError) this.onError('Not currently connected');
      return;
    }

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

  /**
   * Show the registration panel, hiding the room input
   */
  showRegisterPanel() {
    const username = this.els.loginUsername?.value.trim();
    const password = this.els.loginPassword?.value;
    if (!username || !password) {
      if (this.onError) this.onError('Please enter username and password first');
      return;
    }
    // Pre-fill and lock username/password from the login form
    if (this.els.registerUsername) {
      this.els.registerUsername.value = username;
    }
    if (this.els.registerPassword) {
      this.els.registerPassword.value = password;
    }
    // Clear optional fields
    if (this.els.registerEmail) this.els.registerEmail.value = '';
    if (this.els.registerSecretQuestion) this.els.registerSecretQuestion.value = '';
    if (this.els.registerSecretAnswer) this.els.registerSecretAnswer.value = '';

    // Hide room input, login form, divider, and offline button; show registration panel
    if (this.els.roomIdInput) this.els.roomIdInput.style.display = 'none';
    if (this.els.authNotLoggedIn) this.els.authNotLoggedIn.style.display = 'none';
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    if (divider) divider.style.display = 'none';
    if (offlineBtn) offlineBtn.style.display = 'none';
    if (this.els.registerPanel) this.els.registerPanel.style.display = 'flex';
  }

  /**
   * Hide the registration panel, restore the login form
   */
  hideRegisterPanel() {
    if (this.els.registerPanel) this.els.registerPanel.style.display = 'none';
    if (this.els.roomIdInput) this.els.roomIdInput.style.display = '';
    if (this.els.authNotLoggedIn) this.els.authNotLoggedIn.style.display = 'flex';
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    if (divider) divider.style.display = '';
    if (offlineBtn) offlineBtn.style.display = '';
  }

  handleRegister() {
    if (this._loading) return;

    const username = this.els.registerUsername?.value.trim();
    const password = this.els.registerPassword?.value;
    const email = this.els.registerEmail?.value.trim() || '';
    const secretQuestion = this.els.registerSecretQuestion?.value.trim() || '';
    const secretAnswer = this.els.registerSecretAnswer?.value.trim() || '';

    if (!username || !password) {
      if (this.onError) this.onError('Username and password are required');
      return;
    }

    if (secretQuestion && !secretAnswer) {
      if (this.onError) this.onError('Please provide a secret answer for your question');
      return;
    }

    this._pendingUsername = username;
    this._pendingRegister = true;
    this.setLoading(true);
    this.wsClient.sendAuthRegister(username, password, { email, secretQuestion, secretAnswer });
  }

  attemptAutoLogin() {
    const token = this.getStoredToken();
    if (!token) return false;

    // Send token if we have one — covers room switches within a session,
    // "remember me" across page reloads, and page refreshes with a stored token
    this.wsClient.sendAuthTokenLogin(token);
    return true;
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

      // Hide register panel if it was open
      if (this._pendingRegister) {
        this._pendingRegister = false;
        this.hideRegisterPanel();
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
      this._pendingRegister = false;

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
    const btns = [this.els.loginJoinBtn, this.els.editLoginJoinBtn, this.els.registerSubmitBtn];

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
