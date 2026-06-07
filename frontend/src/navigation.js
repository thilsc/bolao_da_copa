import { showScreen, showAuthTab, startApp, getCurrentUser } from './auth.js';
import { loadMatches, loadPendingUsers } from './matches.js';
import { loadRanking } from './ranking.js';

export function switchTab(tab, clickedBtn) {
  // Panels
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');

  // Bottom nav - mostrar/ocultar botões baseado no papel do usuário
  const palpitesBtn = document.getElementById('nav-palpites');
  const adminBtn = document.getElementById('nav-admin');
  if (getCurrentUser()?.role === 'admin') {
    // Admin não vê botão Palpites, vê botão Admin
    if (palpitesBtn) palpitesBtn.style.display = 'none';
    if (adminBtn) adminBtn.style.display = 'flex';
  } else {
    // Usuário normal vê botão Palpites, não vê botão Admin
    if (palpitesBtn) palpitesBtn.style.display = 'flex';
    if (adminBtn) adminBtn.style.display = 'none';
  }
  
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const bottomBtn = document.getElementById(`nav-${tab}`);
  if (bottomBtn) bottomBtn.classList.add('active');

  // Top tabs
  document.querySelectorAll('.top-tab-btn').forEach(b => b.classList.remove('active'));
  const topBtn = document.getElementById(`top-${tab}`);
  if (topBtn) topBtn.classList.add('active');
  else if (clickedBtn?.classList.contains('top-tab-btn')) clickedBtn.classList.add('active');

  if (tab === 'ranking') loadRanking();
  if (tab === 'admin' && getCurrentUser()?.role === 'admin') loadPendingUsers();
  if (tab === 'palpites') loadMatches();
}
