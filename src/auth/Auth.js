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
      // Not logged in form
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginJoinBtn: document.getElementById('loginJoinBtn'),
      rememberMe: document.getElementById('rememberMe'),
      // Logged in state
      authUsernameBtn: document.getElementById('authUsernameBtn'),
      authUsernameDisplay: document.getElementById('authUsernameDisplay'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
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
      roomIdInput: document.getElementById('roomIdInput'),
      authFormWrapper: document.getElementById('authFormWrapper')
    };

    // Load remember me preference
    if (this.els.rememberMe) {
      this.els.rememberMe.checked = this.getRememberMe();
    }

    this.setupListeners();
    this.syncAuthStateHeights();
    window.addEventListener('resize', () => this.syncAuthStateHeights());

    // Check if user has stored credentials for auto-login
    this.checkStoredLogin();
  }

  setupListeners() {
    // Dynamic button text
    this.els.loginPassword?.addEventListener('input', () => {
      this.updateButtonText(this.els.loginPassword, this.els.loginJoinBtn);
    });

    // Consolidated buttons
    this.els.loginJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerPrimaryAction();
    });

    this.els.joinBtnLoggedIn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    // Enter key on password fields
    this.els.loginPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.triggerPrimaryAction();
      }
    });

    // Username button (logged in state) - logs out to show login menu
    this.els.authUsernameBtn?.addEventListener('click', () => {
      const currentUsername = this.loggedInUsername;
      this.logout();
      if (this.els.loginUsername) {
        this.els.loginUsername.value = currentUsername || '';
      }
    });

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
   * Trigger login when credentials are present, otherwise continue with join.
   */
  triggerPrimaryAction() {
    if (!this.isLoggedIn && this.els.loginPassword?.value) {
      this.handleLogin();
      return;
    }

    this.triggerJoin();
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
   * Helper to switch between elements with a fade and height animation
   */
  async _transitionTo(toEl, fromEls = []) {
    const duration = 200; // Match CSS transition duration
    const wrapper = this.els.authFormWrapper;

    // 1. Measure current height
    let oldHeight = 0;
    if (wrapper) {
      oldHeight = wrapper.offsetHeight;
      wrapper.style.height = oldHeight + 'px';
    }

    // 2. Start fading out old elements
    fromEls.forEach(el => {
      if (el && el.style.display !== 'none') {
        el.classList.remove('auth-fade-in');
        el.classList.add('auth-fade-out');
      }
    });

    // Wait for fade out
    await new Promise(r => setTimeout(r, duration));

    // 3. Hide old elements and prepare new element (but keep it invisible)
    fromEls.forEach(el => {
      if (el) {
        el.style.display = 'none';
        el.classList.remove('auth-fade-out');
      }
    });

    if (toEl) {
      toEl.style.display = 'flex';
      toEl.style.opacity = '0';
      toEl.style.transform = 'translateY(10px)';
    }

    // 4. Measure new height and animate
    if (wrapper && toEl) {
      const newHeight = wrapper.scrollHeight;
      wrapper.style.height = newHeight + 'px';
      
      // Wait for height animation
      await new Promise(r => setTimeout(r, duration));
    }

    // 5. Fade in new element
    if (toEl) {
      toEl.style.opacity = '';
      toEl.style.transform = '';
      toEl.classList.add('auth-fade-in');
      
      // Cleanup
      setTimeout(() => {
        toEl.classList.remove('auth-fade-in');
        if (wrapper) wrapper.style.height = '';
      }, duration);
    } else if (wrapper) {
      wrapper.style.height = '';
    }
  }

  /**
   * Keep login and logged-in panels at the same height to avoid UI popping.
   */
  syncAuthStateHeights() {
    const states = [this.els.authNotLoggedIn, this.els.authLoggedIn].filter(Boolean);
    const loginForm = document.getElementById('loginForm');
    const wrapper = this.els.authFormWrapper;
    if (!states.length || !loginForm || !wrapper) return;

    const originalStyles = states.map((el) => ({
      el,
      display: el.style.display,
      position: el.style.position,
      visibility: el.style.visibility,
      pointerEvents: el.style.pointerEvents,
      width: el.style.width
    }));
    const originalFormDisplay = loginForm.style.display;
    const originalWrapperMinHeight = wrapper.style.minHeight;

    let maxHeight = 0;
    let maxFormHeight = 0;

    states.forEach((el) => {
      el.style.display = 'flex';
      el.style.position = 'absolute';
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      el.style.width = '100%';
      maxHeight = Math.max(maxHeight, el.offsetHeight);
      maxFormHeight = Math.max(maxFormHeight, loginForm.scrollHeight);
    });

    originalStyles.forEach(({ el, display, position, visibility, pointerEvents, width }) => {
      el.style.display = display;
      el.style.position = position;
      el.style.visibility = visibility;
      el.style.pointerEvents = pointerEvents;
      el.style.width = width;
    });
    loginForm.style.display = originalFormDisplay;

    if (maxHeight > 0) {
      states.forEach((el) => {
        el.style.minHeight = `${maxHeight}px`;
      });
    }

    if (maxFormHeight > 0) {
      wrapper.style.minHeight = `${maxFormHeight}px`;
    } else {
      wrapper.style.minHeight = originalWrapperMinHeight;
    }
  }

  /**
   * Show the logged-in UI state
   */
  async showLoggedInState(username) {
    const wasLoggedIn = this.isLoggedIn;
    this.isLoggedIn = true;
    this.loggedInUsername = username;

    if (this.els.authUsernameDisplay) this.els.authUsernameDisplay.textContent = username;
    this.syncAuthStateHeights();

    if (!wasLoggedIn) {
      await this._transitionTo(this.els.authLoggedIn, [this.els.authNotLoggedIn, this.els.registerPanel]);
    }

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(true, username);
    }
  }

  /**
   * Show the not-logged-in UI state
   */
  async showNotLoggedInState() {
    this.isLoggedIn = false;
    this.loggedInUsername = null;
    this.syncAuthStateHeights();

    await this._transitionTo(this.els.authNotLoggedIn, [this.els.authLoggedIn, this.els.registerPanel]);

    // Reset button text
    this.updateButtonText(this.els.loginPassword, this.els.loginJoinBtn);

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(false, null);
    }
  }

  /**
   * Log out the current user (clear session/token)
   */
  logout() {
    this.clearToken();
    this.clearStoredUsername();
    this.setRememberMe(false);
    void this.showNotLoggedInState();
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
  async showRegisterPanel() {
    const username = this.els.loginUsername?.value.trim() || '';
    const password = this.els.loginPassword?.value || '';

    // Pre-fill username/password from the login form
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
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    
    if (this.els.roomIdInput) this.els.roomIdInput.style.display = 'none';
    if (divider) divider.style.display = 'none';
    if (offlineBtn) offlineBtn.style.display = 'none';

    await this._transitionTo(this.els.registerPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn]);
  }

  /**
   * Hide the registration panel, restore the login form
   */
  async hideRegisterPanel() {
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    
    if (this.els.roomIdInput) this.els.roomIdInput.style.display = '';
    if (divider) divider.style.display = '';
    if (offlineBtn) offlineBtn.style.display = '';

    await this._transitionTo(this.els.authNotLoggedIn, [this.els.registerPanel]);
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
    const btns = [this.els.loginJoinBtn, this.els.registerSubmitBtn];

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
