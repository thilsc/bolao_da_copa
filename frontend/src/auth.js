// ── State ────────────────────────────────────────────────────────
const state = {
  currentUser: null,
  allMatches: [],
  userPredictions: [],
  activeGroup: 'all'
};

// Getters e setters para compatibilidade
export const getCurrentUser = () => state.currentUser;
export const setCurrentUser = (user) => { state.currentUser = user; };
export const getAllMatches = () => state.allMatches;
export const setAllMatches = (matches) => { state.allMatches = matches; };
export const getUserPredictions = () => state.userPredictions;
export const setUserPredictions = (predictions) => { state.userPredictions = predictions; };
export const getActiveGroup = () => state.activeGroup;
export const setActiveGroup = (group) => { state.activeGroup = group; };

const API_BASE_URL = '';

// ── API Helper ────────────────────────────────────────────────────
export function apiFetch(url, opts = {}) {
  const token = localStorage.getItem('bolao_token');
  const fullUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
  return fetch(fullUrl, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(opts.headers || {})
    }
  });
}

// ── Screen management ─────────────────────────────────────────────
export function showScreen(name) {
  document.getElementById('loading').style.display = 'none';
  ['auth', 'verify', 'app'].forEach(s =>
    document.getElementById(`${s}-screen`).classList.remove('active')
  );
  document.getElementById(`${name}-screen`).classList.add('active');
}

// Loading overlay functions
export function showLoading(message = 'Carregando...') {
  const loading = document.getElementById('loading');
  loading.querySelector('span').textContent = message;
  loading.style.display = 'flex';
}

export function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}

// ── Auth tabs ─────────────────────────────────────────────────────
export function showAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b, i) =>
    b.classList.toggle('active', (i === 0) === (tab === 'login'))
  );
  document.getElementById('login-form').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('login-msg').innerHTML = '';
  document.getElementById('register-msg').innerHTML = '';
}

// ── Auth handlers ─────────────────────────────────────────────────
export async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const msg = document.getElementById('login-msg');
  setLoading(btn, true);
  msg.innerHTML = '';

  try {
    const res = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needsVerification) {
        document.getElementById('verify-email-display').textContent =
          document.getElementById('login-email').value.trim();
        showScreen('verify');
      } else {
        showMsg(msg, data.error, 'error');
      }
      return;
    }
    localStorage.setItem('bolao_token', data.token);
    setCurrentUser(data.user);
    startApp();
  } catch (_) {
    showMsg(msg, 'Erro de conexão. Tente novamente.', 'error');
  } finally {
    setLoading(btn, false, 'Entrar');
  }
}

export async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('register-btn');
  const msg = document.getElementById('register-msg');
  const pass = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;

  if (pass !== confirm) {
    showMsg(msg, 'As senhas não coincidem.', 'error');
    return;
  }

  setLoading(btn, true);
  msg.innerHTML = '';

  try {
    const res = await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('reg-name').value.trim(),
        email: document.getElementById('reg-email').value.trim(),
        password: pass
      })
    });
    const data = await res.json();
    if (!res.ok) { showMsg(msg, data.error, 'error'); return; }

    const email = document.getElementById('reg-email').value.trim();
    document.getElementById('verify-email-display').textContent = email;
    showScreen('verify');
  } catch (_) {
    showMsg(msg, 'Erro de conexão. Tente novamente.', 'error');
  } finally {
    setLoading(btn, false, 'Criar conta');
  }
}

export async function verifyEmailToken(token) {
  try {
    const res = await apiFetch(`/api/users/verify/${token}`);
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('bolao_token', data.token);
      setCurrentUser(data.user);
      startApp();
    } else {
      showScreen('auth');
      setTimeout(() =>
        showMsg(document.getElementById('login-msg'), data.error + ' Faça login ou cadastre-se novamente.', 'error')
      , 100);
    }
  } catch (_) {
    showScreen('auth');
  }
}

export async function resendVerification() {
  const email = document.getElementById('verify-email-display').textContent;
  const btn = document.getElementById('resend-btn');
  const msg = document.getElementById('resend-msg');
  setLoading(btn, true);
  try {
    const res = await apiFetch('/api/users/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    showMsg(msg, res.ok ? '✅ E-mail reenviado!' : data.error, res.ok ? 'success' : 'error');
  } catch (_) {
    showMsg(msg, 'Erro de conexão.', 'error');
  } finally {
    setLoading(btn, false, '🔁 Reenviar e-mail');
  }
}

export function logout() {
  localStorage.removeItem('bolao_token');
  setCurrentUser(null);
  setAllMatches([]);
  setUserPredictions([]);
  showScreen('auth');
  showAuthTab('login');
}

// ── App startup ───────────────────────────────────────────────────
export async function startApp() {
  document.getElementById('header-user-name').textContent = getCurrentUser().name;
  showScreen('app');
 
  await Promise.all([loadMatches(), loadRanking()]);
  
  if (getCurrentUser()?.email === 'admin@bolao.com')
  {
    document.getElementById('top-palpites').style.display = 'none';
    document.getElementById('nav-palpites').style.display = 'none';
  }

  // Definir a aba inicial baseada no papel do usuário
  const isAdmin = getCurrentUser()?.role === 'admin';
  const initialTab = isAdmin ? 'admin' : 'palpites';

  document.getElementById('top-admin').style.display = isAdmin ? '' : 'none';
  document.getElementById('nav-admin').style.display = isAdmin ? '' : 'none';

  switchTab(initialTab, null);
}

// ── Helpers ───────────────────────────────────────────────────────
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function showMsg(el, text, type) {
  el.innerHTML = `<div class="alert alert-${type}" style="margin-top:4px">${text}</div>`;
}

export function setLoading(btn, loading, label) {
  btn.disabled = loading;
  if (loading) btn.innerHTML = '<div class="spinner"></div>';
  else if (label) btn.textContent = label;
}

// Exportações auxiliares para outros módulos
import { loadMatches } from './matches.js';
import { loadRanking } from './ranking.js';
import { switchTab } from './navigation.js';
