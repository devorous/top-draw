/**
 * Auth module — handles token storage, login/register form logic, auto-login
 */
const TOKEN_KEY = 'topDrawAuthToken';
const REMEMBER_ME_KEY = 'topDrawRememberMe';

export class Auth {
  constructor({ wsClient, onSuccess, onError }) {
    this.wsClient = wsClient;
    this.onSuccess = onSuccess;
    this.onError = onError;

    // DOM elements (cached in init)
    this.els = {};
  }

  init() {
    this.els = {
      authTabs: document.getElementById('authTabs'),
      loginTab: document.getElementById('authTabLogin'),
      registerTab: document.getElementById('authTabRegister'),
      loginForm: document.getElementById('loginForm'),
      registerForm: document.getElementById('registerForm'),
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginBtn: document.getElementById('loginBtn'),
      regUsername: document.getElementById('regUsername'),
      regPassword: document.getElementById('regPassword'),
      regConfirm: document.getElementById('regConfirm'),
      registerBtn: document.getElementById('registerBtn'),
      guestBtn: document.getElementById('guestBtn'),
      authError: document.getElementById('authError'),
      rememberMe: document.getElementById('rememberMe')
    };

    // Load remember me preference
    if (this.els.rememberMe) {
      this.els.rememberMe.checked = this.getRememberMe();
    }

    this.setupListeners();
  }

  setupListeners() {
    // Tab switching
    this.els.loginTab?.addEventListener('click', () => this.showTab('login'));
    this.els.registerTab?.addEventListener('click', () => this.showTab('register'));

    // Form submission
    this.els.loginBtn?.addEventListener('click', () => this.handleLogin());
    this.els.registerBtn?.addEventListener('click', () => this.handleRegister());

    // Enter key on inputs
    this.els.loginPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleLogin();
    });
    this.els.regConfirm?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleRegister();
    });
  }

  showTab(tab) {
    if (tab === 'login') {
      this.els.loginTab.classList.add('active');
      this.els.registerTab.classList.remove('active');
      this.els.loginForm.style.display = 'block';
      this.els.registerForm.style.display = 'none';
    } else {
      this.els.loginTab.classList.remove('active');
      this.els.registerTab.classList.add('active');
      this.els.loginForm.style.display = 'none';
      this.els.registerForm.style.display = 'block';
    }
    this.clearError();
  }

  handleLogin() {
    const username = this.els.loginUsername.value.trim();
    const password = this.els.loginPassword.value;

    if (!username || !password) {
      this.showError('Please enter username and password');
      return;
    }

    this.wsClient.sendAuthLogin(username, password);
  }

  handleRegister() {
    const username = this.els.regUsername.value.trim();
    const password = this.els.regPassword.value;
    const confirm = this.els.regConfirm.value;

    if (!username || !password) {
      this.showError('Please fill in all fields');
      return;
    }
    if (password !== confirm) {
      this.showError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      this.showError('Password must be at least 6 characters');
      return;
    }

    this.wsClient.sendAuthRegister(username, password);
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
    if (data.success) {
      if (data.token) {
        this.storeToken(data.token);
        // Store remember me preference
        if (this.els.rememberMe) {
          this.setRememberMe(this.els.rememberMe.checked);
        }
      }
      if (this.onSuccess) {
        this.onSuccess(data.token, data.role, data.username);
      }
    } else {
      // If auto-login failed, clear the invalid token and remember me preference
      if (this.getStoredToken()) {
        this.clearToken();
        this.setRememberMe(false);
      }

      const errorMessage = data.error || 'Authentication failed';

      if (this.onError) {
        this.onError(errorMessage);
      }
      this.showError(errorMessage);
    }
  }

  showError(message) {
    if (this.els.authError) {
      this.els.authError.textContent = message;
      this.els.authError.style.display = 'block';
    }
  }

  clearError() {
    if (this.els.authError) {
      this.els.authError.textContent = '';
      this.els.authError.style.display = 'none';
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
}
