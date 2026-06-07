import { apiFetch, getCurrentUser } from './auth.js';

export async function loadRanking() {
  try {
    const res = await apiFetch('/api/ranking');
    const ranking = await res.json();
    const medals = ['gold', 'silver', 'bronze'];
    document.getElementById('ranking-container').innerHTML =
      ranking.length ? ranking.map((u, i) => `
        <div class="ranking-item ${u.id === getCurrentUser()?.id ? 'rank-me' : ''}">
          <div class="rank-pos ${medals[i] || 'other'}">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</div>
          <div class="rank-info">
            <div class="rank-name">${u.name}${u.id === getCurrentUser()?.id ? ' <small>(você)</small>' : ''}</div>
            <div class="rank-email">${u.email}</div>
          </div>
          <div class="rank-pts">${u.total_points}<span>${u.predictions_count} palpites</span></div>
        </div>`).join('')
      : '<div class="empty-state"><div class="icon">🏆</div><p>Nenhum placar registrado ainda.</p></div>';
  } catch (_) {}
}
