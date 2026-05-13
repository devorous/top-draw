/**
 * Auth module — handles token storage, login/register form logic, auto-login
 */
const TOKEN_KEY = 'topDrawAuthToken';
const REMEMBER_ME_KEY = 'topDrawRememberMe';
const USERNAME_KEY = 'topDrawUsername';
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const TOKEN_INVALID_ERRORS = new Set([
  'Invalid or expired token',
  'Account not found',
]);

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
    this.currentAuthSession = null;
    this._autoLoginInFlight = false;
    this._autoLoginToken = null;

  }

  isCompactHeightLayout() {
    return window.innerHeight <= 820;
  }

  resetAuthLayoutSizing() {
    const wrapper = this.els.authFormWrapper;
    if (wrapper) {
      wrapper.style.height = '';
      wrapper.style.minHeight = '';
    }

    [this.els.authNotLoggedIn, this.els.authLoggedIn, this.els.registerPanel, this.els.passwordResetPanel]
      .filter(Boolean)
      .forEach((el) => {
        el.style.minHeight = '';
      });
  }

  init() {
    console.log('[Auth] init() called');
    this.els = {
      // Login state elements
      authNotLoggedIn: document.getElementById('authNotLoggedIn'),
      authLoggedIn: document.getElementById('authLoggedIn'),
      // Not logged in form
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginBtn: document.getElementById('loginBtn'),
      guestJoinBtn: document.getElementById('guestJoinBtn'),
      loginJoinBtn: document.getElementById('loginJoinBtn'),
      rememberMe: document.getElementById('rememberMe'),
      // Logged in state
      authUsernameBtn: document.getElementById('authUsernameBtn'),
      authUsernameDisplay: document.getElementById('authUsernameDisplay'),
      authLoggedInJoinBtn: document.getElementById('authLoggedInJoinBtn'),
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
      forgotPasswordBtn: document.getElementById('forgotPasswordBtn'),
      passwordResetPanel: document.getElementById('authPasswordResetPanel'),
      passwordResetTitle: document.getElementById('passwordResetTitle'),
      passwordResetClose: document.getElementById('passwordResetClose'),
      passwordResetIdentifier: document.getElementById('passwordResetIdentifier'),
      passwordResetSecretWrap: document.getElementById('passwordResetSecretWrap'),
      passwordResetSecretQuestion: document.getElementById('passwordResetSecretQuestion'),
      passwordResetSecretAnswer: document.getElementById('passwordResetSecretAnswer'),
      passwordResetRequestFields: document.getElementById('passwordResetRequestFields'),
      passwordResetCompleteFields: document.getElementById('passwordResetCompleteFields'),
      passwordResetNewPassword: document.getElementById('passwordResetNewPassword'),
      passwordResetConfirmPassword: document.getElementById('passwordResetConfirmPassword'),
      passwordResetMessage: document.getElementById('passwordResetMessage'),
      passwordResetSubmitBtn: document.getElementById('passwordResetSubmitBtn'),
      // Add email modal
      addEmailStep1: document.getElementById('addEmailStep1'),
      addEmailStep2: document.getElementById('addEmailStep2'),
      addEmailInput: document.getElementById('addEmailInput'),
      addEmailCodeInput: document.getElementById('addEmailCodeInput'),
      addEmailMessage: document.getElementById('addEmailMessage'),
      addEmailCodeMessage: document.getElementById('addEmailCodeMessage'),
      addEmailTarget: document.getElementById('addEmailTarget'),
      addEmailSendBtn: document.getElementById('addEmailSendBtn'),
      addEmailVerifyBtn: document.getElementById('addEmailVerifyBtn'),
      addEmailResendBtn: document.getElementById('addEmailResendBtn'),
      addEmailSkipBtn: document.getElementById('addEmailSkipBtn'),
      roomIdInput: document.getElementById('roomIdInput'),
      authFormWrapper: document.getElementById('authFormWrapper'),
      authLoadingState: document.getElementById('authLoadingState'),
      landingAuthPanel: document.getElementById('landingAuthPanel')
    };

    // Load remember me preference
    if (this.els.rememberMe) {
      this.els.rememberMe.checked = this.getRememberMe();
    }

    this.setupListeners();
    this.syncAuthStateHeights();
    window.addEventListener('resize', () => this.syncAuthStateHeights());

    // Listen for auth results from WebSocket (in case it fires before AuthModHandlers sets up the main listener)
    if (this.wsClient) {
      this.wsClient.on('auth_result', (data) => this.handleAuthResult(data));
    }

    // Check if user has stored credentials for auto-login
    const openedPasswordReset = this.openPasswordResetFromUrl();
    if (!openedPasswordReset) {
      this.checkStoredLogin();
    }
    if (openedPasswordReset || !this.getStoredToken()) {
      this.setAuthPending(false);
    }
  }

  setupListeners() {
    this.els.loginBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    this.els.guestJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.loginJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.joinBtnLoggedIn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.authLoggedInJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    // Enter key on password fields
    this.els.loginPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleLogin();
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
    this.els.forgotPasswordBtn?.addEventListener('click', () => this.showPasswordResetRequestPanel());
    this.els.passwordResetClose?.addEventListener('click', () => this.hidePasswordResetPanel());
    this.els.passwordResetSubmitBtn?.addEventListener('click', () => this.handlePasswordResetSubmit());
    [
      this.els.passwordResetIdentifier,
      this.els.passwordResetSecretAnswer,
      this.els.passwordResetNewPassword,
      this.els.passwordResetConfirmPassword
    ].filter(Boolean).forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handlePasswordResetSubmit();
        }
      });
    });

    // Add email modal
    this.els.addEmailSkipBtn?.addEventListener('click', () => this.hideAddEmailModal(true));
    this.els.addEmailSendBtn?.addEventListener('click', () => this.handleSendEmailCode());
    this.els.addEmailVerifyBtn?.addEventListener('click', () => this.handleVerifyEmailCode());
    this.els.addEmailResendBtn?.addEventListener('click', () => this.handleSendEmailCode());
    [this.els.addEmailInput, this.els.addEmailCodeInput].filter(Boolean).forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this._addEmailStep === 1) this.handleSendEmailCode();
          else this.handleVerifyEmailCode();
        }
      });
    });
    // Close modal on backdrop click (counts as decline)
    document.getElementById('addEmailModalBackdrop')?.addEventListener('click', () => this.hideAddEmailModal(true));
  }

  isJoinActionEnabled() {
    const activeJoinButtons = this.isLoggedIn
      ? [this.els.authLoggedInJoinBtn, this.els.joinBtnLoggedIn]
      : [this.els.loginJoinBtn, this.els.guestJoinBtn];
    return activeJoinButtons.some((button) => button && !button.disabled);
  }

  /**
   * Manually trigger the join process via the form submit event
   */
  triggerJoin() {
    if (!this.isJoinActionEnabled()) return;

    const form = document.getElementById('loginForm');
    if (form) {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }

  /**
   * Check if user has stored login credentials
   */
  checkStoredLogin() {
    console.log('[Auth] checkStoredLogin() called');
    // Attempt auto-login with stored token (don't show UI yet, wait for auth result)
    if (this.getStoredToken()) {
      console.log('[Auth] Found stored token, attempting auto-login');
      this.attemptAutoLogin();
    } else {
      console.log('[Auth] No stored token found');
    }
  }

  /**
   * Helper to switch between elements with a fade and height animation
   */
  async _transitionTo(toEl, fromEls = []) {
    const duration = 200; // Match CSS transition duration
    const wrapper = this.els.authFormWrapper;
    const compactLayout = this.isCompactHeightLayout();

    // 1. Measure current height
    let oldHeight = 0;
    if (wrapper && !compactLayout) {
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
    if (wrapper && toEl && !compactLayout) {
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
    const loginForm = document.getElementById('loginForm');
    const wrapper = this.els.authFormWrapper;
    if (!loginForm || !wrapper) return;

    if (this.isCompactHeightLayout()) {
      this.resetAuthLayoutSizing();
      return;
    }
  }

  /**
   * Show the logged-in UI state
   */
  async showLoggedInState(username) {
    console.log('[Auth] showLoggedInState called:', username);
    const wasLoggedIn = this.isLoggedIn;
    this.isLoggedIn = true;
    this.loggedInUsername = username;

    if (this.els.authUsernameDisplay) this.els.authUsernameDisplay.textContent = username;
    this.els.landingAuthPanel?.classList.add('auth-is-logged-in');
    this.syncAuthStateHeights();

    if (!wasLoggedIn) {
      await this._transitionTo(this.els.authLoggedIn, [this.els.authNotLoggedIn, this.els.registerPanel, this.els.passwordResetPanel]);
    }

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(true, username);
    }

    this.scrollRoomsIntoViewOnSmallScreens();
  }

  /**
   * Show the not-logged-in UI state
   */
  async showNotLoggedInState() {
    this.isLoggedIn = false;
    this.loggedInUsername = null;
    this.els.landingAuthPanel?.classList.remove('auth-is-logged-in');
    this.syncAuthStateHeights();

    await this._transitionTo(this.els.authNotLoggedIn, [this.els.authLoggedIn, this.els.registerPanel, this.els.passwordResetPanel]);

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

  async handleLogin() {
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
    await this.wsClient.sendAuthLogin(username, password);
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

    // Hide landing-only actions while the account panel is open.
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    
    if (divider) divider.style.display = 'none';
    if (offlineBtn) offlineBtn.style.display = 'none';

    await this._transitionTo(this.els.registerPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn, this.els.passwordResetPanel]);
  }

  /**
   * Hide the registration panel, restore the login form
   */
  async hideRegisterPanel() {
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    
    if (divider) divider.style.display = '';
    if (offlineBtn) offlineBtn.style.display = '';

    await this._transitionTo(this.els.authNotLoggedIn, [this.els.registerPanel]);
  }

  setPasswordResetMessage(message, kind = 'neutral') {
    if (!this.els.passwordResetMessage) return;
    this.els.passwordResetMessage.textContent = message || '';
    this.els.passwordResetMessage.dataset.kind = kind;
  }

  setPasswordResetMode(mode) {
    const completeMode = mode === 'complete';
    this._passwordResetMode = mode;
    if (this.els.passwordResetTitle) {
      this.els.passwordResetTitle.textContent = completeMode ? 'Choose New Password' : 'Reset Password';
    }
    if (this.els.passwordResetRequestFields) {
      this.els.passwordResetRequestFields.style.display = completeMode ? 'none' : '';
    }
    if (this.els.passwordResetCompleteFields) {
      this.els.passwordResetCompleteFields.style.display = completeMode ? '' : 'none';
    }
    if (this.els.passwordResetSubmitBtn) {
      const label = completeMode ? 'Change Password' : 'Send Link';
      if (this._loading) this.els.passwordResetSubmitBtn._oldText = label;
      else this.els.passwordResetSubmitBtn.textContent = label;
    }
  }

  openPasswordResetFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('resetToken');
    if (!token) return false;

    this._passwordResetToken = token;
    void this.showPasswordResetCompletePanel();
    params.delete('resetToken');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
    return true;
  }

  async showPasswordResetRequestPanel() {
    if (this.els.passwordResetIdentifier) this.els.passwordResetIdentifier.value = '';
    this._passwordResetToken = null;
    this.setPasswordResetMode('request');
    this.setPasswordResetMessage('');

    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    if (divider) divider.style.display = 'none';
    if (offlineBtn) offlineBtn.style.display = 'none';

    await this._transitionTo(this.els.passwordResetPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn, this.els.registerPanel]);
  }

  async showPasswordResetCompletePanel() {
    if (this.els.passwordResetNewPassword) this.els.passwordResetNewPassword.value = '';
    if (this.els.passwordResetConfirmPassword) this.els.passwordResetConfirmPassword.value = '';
    this.setPasswordResetMode('complete');
    this.setPasswordResetMessage('Enter a new password for this reset link.');

    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    if (divider) divider.style.display = 'none';
    if (offlineBtn) offlineBtn.style.display = 'none';

    await this._transitionTo(this.els.passwordResetPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn, this.els.registerPanel]);
  }

  async hidePasswordResetPanel() {
    const divider = document.querySelector('.landingDivider');
    const offlineBtn = document.getElementById('loginOfflineBtn');
    if (divider) divider.style.display = '';
    if (offlineBtn) offlineBtn.style.display = '';
    this._passwordResetToken = null;
    await this._transitionTo(this.els.authNotLoggedIn, [this.els.passwordResetPanel]);
  }

  async handlePasswordResetSubmit() {
    if (this._loading) return;

    if (this._passwordResetMode === 'complete') {
      await this.completePasswordReset();
    } else {
      await this.requestPasswordReset();
    }
  }

  async requestPasswordReset() {
    const identifier = this.els.passwordResetIdentifier?.value.trim();
    if (!identifier || !identifier.includes('@')) {
      this.setPasswordResetMessage('Enter your email address.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Password reset failed');
      }

      if (data.requiresSecretAnswer) {
        if (this.els.passwordResetSecretWrap) this.els.passwordResetSecretWrap.style.display = '';
        if (this.els.passwordResetSecretQuestion) this.els.passwordResetSecretQuestion.textContent = data.secretQuestion || '';
        if (this.els.passwordResetSubmitBtn) {
          if (this._loading) this.els.passwordResetSubmitBtn._oldText = 'Verify Answer';
          else this.els.passwordResetSubmitBtn.textContent = 'Verify Answer';
        }
        this.setPasswordResetMessage('Answer your secret question to create a reset link.');
        return;
      }

      if (data.resetLink) {
        const url = new URL(data.resetLink, window.location.origin);
        this._passwordResetToken = url.searchParams.get('resetToken');
        await this.showPasswordResetCompletePanel();
        return;
      }

      this.setPasswordResetMessage(data.message || 'If that account can be reset, check your email.', 'success');
    } catch (err) {
      this.setPasswordResetMessage(err.message || 'Password reset failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async completePasswordReset() {
    const password = this.els.passwordResetNewPassword?.value || '';
    const confirmPassword = this.els.passwordResetConfirmPassword?.value || '';
    if (!this._passwordResetToken) {
      this.setPasswordResetMessage('Reset link is missing. Request a new one.', 'error');
      return;
    }
    if (password.length < 6) {
      this.setPasswordResetMessage('Password must be at least 6 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      this.setPasswordResetMessage('Passwords do not match.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/password-reset/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this._passwordResetToken, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Password reset failed');
      }

      this.setPasswordResetMessage(data.message || 'Password updated. You can log in now.', 'success');
      if (this.els.passwordResetNewPassword) this.els.passwordResetNewPassword.value = '';
      if (this.els.passwordResetConfirmPassword) this.els.passwordResetConfirmPassword.value = '';
      this._passwordResetToken = null;
      setTimeout(() => this.hidePasswordResetPanel(), 1200);
    } catch (err) {
      this.setPasswordResetMessage(err.message || 'Password reset failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  showAddEmailModal() {
    console.log('[Auth] showAddEmailModal called');
    this._addEmailStep = 1;
    if (this.els.addEmailInput) this.els.addEmailInput.value = '';
    if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.value = '';
    if (this.els.addEmailMessage) this.els.addEmailMessage.textContent = '';
    if (this.els.addEmailCodeMessage) this.els.addEmailCodeMessage.textContent = '';
    if (this.els.addEmailStep1) this.els.addEmailStep1.style.display = '';
    if (this.els.addEmailStep2) this.els.addEmailStep2.style.display = 'none';

    const backdrop = document.getElementById('addEmailModalBackdrop');
    const modal = document.getElementById('addEmailModal');
    const landingPage = document.getElementById('landingPage');
    console.log('[Auth] Modal elements:', { backdrop: !!backdrop, modal: !!modal });
    if (backdrop) backdrop.style.display = 'block';
    if (modal) modal.style.display = 'block';
    if (landingPage) landingPage.classList.add('blurred');
    if (this.els.addEmailInput) this.els.addEmailInput.focus();
  }

  hideAddEmailModal(declinePrompt = false) {
    const backdrop = document.getElementById('addEmailModalBackdrop');
    const modal = document.getElementById('addEmailModal');
    const landingPage = document.getElementById('landingPage');
    if (backdrop) backdrop.style.display = 'none';
    if (modal) modal.style.display = 'none';
    if (landingPage) landingPage.classList.remove('blurred');

    if (declinePrompt) {
      const token = this.getStoredToken();
      if (token) {
        fetch(`${API_BASE}/api/auth/email/decline`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }).catch(() => {});
      }
    }
  }

  setAddEmailMessage(message, kind = 'neutral') {
    if (!this.els.addEmailMessage) return;
    this.els.addEmailMessage.textContent = message || '';
    this.els.addEmailMessage.dataset.kind = kind;
  }

  setAddEmailCodeMessage(message, kind = 'neutral') {
    if (!this.els.addEmailCodeMessage) return;
    this.els.addEmailCodeMessage.textContent = message || '';
    this.els.addEmailCodeMessage.dataset.kind = kind;
  }

  async handleSendEmailCode() {
    if (this._loading) return;

    const email = this.els.addEmailInput?.value.trim();
    if (!email || !email.includes('@')) {
      this.setAddEmailMessage('Please enter a valid email address.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const token = this.getStoredToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const res = await fetch(`${API_BASE}/api/auth/email/set`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to send verification code');
      }

      this._addEmailStep = 2;
      this._addEmailForVerification = email;
      if (this.els.addEmailTarget) this.els.addEmailTarget.textContent = email;
      if (this.els.addEmailStep1) this.els.addEmailStep1.style.display = 'none';
      if (this.els.addEmailStep2) this.els.addEmailStep2.style.display = '';
      if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.value = '';
      this.setAddEmailCodeMessage('');
      if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.focus();
    } catch (err) {
      this.setAddEmailMessage(err.message || 'Failed to send verification code', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async handleVerifyEmailCode() {
    if (this._loading) return;

    const code = this.els.addEmailCodeInput?.value.trim();
    if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
      this.setAddEmailCodeMessage('Please enter a valid 6-digit code.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const token = this.getStoredToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const res = await fetch(`${API_BASE}/api/auth/email/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to verify email');
      }

      this.setAddEmailCodeMessage('Email verified successfully!', 'success');
      setTimeout(() => this.hideAddEmailModal(), 1200);
    } catch (err) {
      this.setAddEmailCodeMessage(err.message || 'Failed to verify email', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async handleRegister() {
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
    await this.wsClient.sendAuthRegister(username, password, { email, secretQuestion, secretAnswer });
  }

  attemptAutoLogin() {
    const token = this.getStoredToken();
    if (!token) return false;

    console.log('[Auth] attemptAutoLogin: token found, wsClient.connected?', this.wsClient?.connected);
    this.setAuthPending(true);

    if (this._autoLoginInFlight && this._autoLoginToken === token) {
      return true;
    }

    this._autoLoginInFlight = true;
    this._autoLoginToken = token;

    // Send token if we have one — covers room switches within a session,
    // "remember me" across page reloads, and page refreshes with a stored token
    if (this.wsClient?.connected) {
      void this.wsClient.sendAuthTokenLogin(token);
    } else {
      console.log('[Auth] WS not connected yet, waiting...');
      // Wait for connection before sending
      const checkConnection = () => {
        if (this.wsClient?.connected) {
          console.log('[Auth] WS now connected, sending auth token');
          void this.wsClient.sendAuthTokenLogin(token);
        } else {
          setTimeout(checkConnection, 100);
        }
      };
      checkConnection();
    }
    return true;
  }

  handleAuthResult(data) {
    console.log('[Auth] handleAuthResult called:', { success: data.success, username: data.username, hasEmail: data.hasEmail, emailPromptDeclined: data.emailPromptDeclined });
    this.setLoading(false);
    this._autoLoginInFlight = false;
    this._autoLoginToken = null;
    this.setAuthPending(false);

    if (data.success) {
      const username = data.username || this._pendingUsername;
      console.log('[Auth] Username for logged-in state:', username);
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
        this.currentAuthSession = {
          token: data.token || this.getStoredToken() || '',
          role: data.role || 0,
          username,
          globalRole: data.globalRole ?? data.role ?? 0,
          roomRole: data.roomRole || 0
        };
        this.showLoggedInState(username);
      }

      // Prompt to add email if missing and user hasn't declined
      if (!data.hasEmail && !data.emailPromptDeclined) {
        setTimeout(() => this.showAddEmailModal(), 100);
      }

      if (this.onSuccess) {
        this.onSuccess(data.token, data.role, username, data.globalRole, data.roomRole);
      }
    } else {
      this._pendingUsername = null;
      this._pendingRegister = false;
      this.currentAuthSession = null;

      const errorMessage = data.error || 'Authentication failed';
      const shouldClearStoredToken = this.getStoredToken() && TOKEN_INVALID_ERRORS.has(errorMessage);

      // Only clear saved auth when the token itself is actually invalid.
      if (shouldClearStoredToken) {
        this.clearToken();
        this.clearStoredUsername();
        this.setRememberMe(false);
        this.showNotLoggedInState();
      }

      if (this.onError) {
        this.onError(errorMessage);
      }
    }
  }

  replayAuthSession() {
    if (!this.currentAuthSession || !this.onSuccess) return false;
    const { token, role, username, globalRole, roomRole } = this.currentAuthSession;
    this.onSuccess(token, role, username, globalRole, roomRole);
    return true;
  }

  setLoading(loading) {
    this._loading = loading;
    const btns = [this.els.loginBtn, this.els.registerSubmitBtn, this.els.passwordResetSubmitBtn];

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
          btn.textContent = btn._oldText || this.getDefaultButtonText(btn);
          btn._oldText = null;
          btn.classList.remove('disabled');
        }
      });
    }
  }

  getDefaultButtonText(btn) {
    if (btn === this.els.loginBtn) return 'Login';
    if (btn === this.els.registerSubmitBtn) return 'Create Account';
    if (btn === this.els.passwordResetSubmitBtn) {
      return this._passwordResetMode === 'complete' ? 'Change Password' : 'Send Link';
    }
    return '';
  }

  setAuthPending(pending) {
    this.els.landingAuthPanel?.classList.toggle('auth-is-pending', pending);
    if (this.els.authLoadingState) {
      this.els.authLoadingState.style.display = pending ? 'flex' : 'none';
    }
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.style.display = pending ? 'none' : '';
    }
  }

  scrollRoomsIntoViewOnSmallScreens() {
    if (!window.matchMedia('(max-width: 768px), (max-height: 720px)').matches) return;

    const roomListSection = document.querySelector('.roomListSection');
    if (!roomListSection) return;

    window.setTimeout(() => {
      roomListSection.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }, 260);
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
