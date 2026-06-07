import { apiFetch, showLoading, hideLoading, showMsg, setLoading, getCurrentUser, getAllMatches, setAllMatches, getUserPredictions, setUserPredictions, getActiveGroup, setActiveGroup } from './auth.js';

// Converte código de país (ex: 'BR', 'US') em emoji de bandeira
export function flagToEmoji(code) {
  if (!code || typeof code !== 'string') return '';
  const c = code.toUpperCase();
  if (c === 'GB-WLS') return '🏴󠁧󠁢󠁷󠁬󠁳󠁿';
  const cp = [...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65);
  if (cp.some(c => c < 0x1F1E6 || c > 0x1F1FF)) return '';
  return String.fromCodePoint(...cp);
}

export async function loadMatches() {
  try {
    const [mRes, pRes] = await Promise.all([
      apiFetch('/api/matches'),
      apiFetch(`/api/users/${getCurrentUser().id}/predictions`)
    ]);
    setAllMatches(await mRes.json());
    setUserPredictions(await pRes.json());
  } catch (_) { setAllMatches([]); setUserPredictions([]); }

  buildGroupFilter();
  renderMatches();
  buildAdminList();
}

export function buildGroupFilter() {
  const groups = ['all', ...new Set(getAllMatches().map(m => m.group_name))];
  const filter = document.getElementById('group-filter');
  filter.innerHTML = groups.map(g => `
    <button class="group-chip ${g === getActiveGroup() ? 'active' : ''}"
            onclick="filterGroup('${g}')">
      ${g === 'all' ? '🌍 Todos' : g}
    </button>`).join('');
}

export function filterGroup(g) {
  setActiveGroup(g);
  buildGroupFilter();
  renderMatches();
}

export function renderMatches() {
  const filtered = getActiveGroup() === 'all'
    ? getAllMatches()
    : getAllMatches().filter(m => m.group_name === getActiveGroup());

  if (!filtered.length) {
    document.getElementById('matches-container').innerHTML =
      '<div class="empty-state"><div class="icon">⚽</div><p>Nenhum jogo encontrado.</p></div>';
    return;
  }

  document.getElementById('matches-container').innerHTML =
    filtered.map(match => renderMatchCard(match)).join('');
}

export function renderMatchCard(match) {
  const pred = getUserPredictions().find(p => Number(p.match_id) === Number(match.id));
  const now = new Date();
  const matchDate = new Date(match.match_date);
  const closed = now >= new Date(matchDate.getTime() - 60 * 60 * 1000);
  const finished = match.status === 'finished';

  const pA = pred?.predicted_score_a ?? 0;
  const pB = pred?.predicted_score_b ?? 0;
  const pR = pred?.predicted_result ?? '';
  const pts = pred?.points;

  const dateStr = matchDate.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo'
  });

  const disabledStr = (closed || finished) ? 'disabled' : '';

  const ptsHtml = (finished && pred) ? `
    <div style="text-align:center;margin-top:8px">
      <span class="points-badge pts-${pts}">${pts} ${pts === 1 ? 'ponto' : 'pontos'}</span>
    </div>` : '';

  const actualScore = finished
    ? `<div class="match-actual-score">Placar final: <strong>${match.score_a} × ${match.score_b}</strong></div>`
    : '';

  const closedBadge = closed && !finished
    ? `<div class="closed-badge">🔒 Palpites encerrados</div>` : '';

  return `
  <div class="match-card">
    <div class="match-card-header">
      <span>${match.group_name}</span>
      <span>${dateStr}</span>
      <span class="round-badge">R${match.round}</span>
    </div>
    <div class="match-card-body">
      ${actualScore}
      <div class="teams-row">
        <div class="team-block">
          <div class="team-flag flag-emoji" data-flag="${flagToEmoji(match.team_a_flag)}"></div>
          <div class="team-name">${match.team_a}</div>
        </div>
        <div class="score-vs">
          <div class="vs-label">PALPITE</div>
          <div class="score-inputs ${closed || finished ? 'locked' : ''}">
            <input type="number" class="score-input" min="0" max="99"
                  value="${pA === null || pA === undefined || pA === '' ? 0 : pA}" ${disabledStr}
                  oninput="syncResult(${match.id})"
                  id="sa-${match.id}" placeholder="0">
            <span class="score-divider">×</span>
            <input type="number" class="score-input" min="0" max="99"
                  value="${pB === null || pB === undefined || pB === '' ? 0 : pB}" ${disabledStr}
                  oninput="syncResult(${match.id})"
                  id="sb-${match.id}" placeholder="0">
          </div>
        </div>
        <div class="team-block">
          <div class="team-flag flag-emoji" data-flag="${flagToEmoji(match.team_b_flag)}"></div>
          <div class="team-name">${match.team_b}</div>
        </div>
      </div>
      <div class="result-row">
        <button class="result-btn ${pR==='A'?'selected':''}" ${disabledStr}
                onclick="selectResult(${match.id},'A')" id="ra-${match.id}">
          ${match.team_a.split(' ')[0]}
        </button>
        <button class="result-btn ${pR==='draw'?'selected':''}" ${disabledStr}
                onclick="selectResult(${match.id},'draw')" id="rd-${match.id}">
          Empate
        </button>
        <button class="result-btn ${pR==='B'?'selected':''}" ${disabledStr}
                onclick="selectResult(${match.id},'B')" id="rb-${match.id}">
          ${match.team_b.split(' ')[0]}
        </button>
      </div>
      ${closedBadge}
      ${!closed && !finished ? `
        <button class="btn btn-primary btn-sm" style="width:100%"
                onclick="savePrediction(${match.id})">
          💾 Salvar palpite
        </button>` : ''}
      ${ptsHtml}
    </div>
  </div>`;
}

export function syncResult(matchId) {
  const a = parseInt(document.getElementById(`sa-${matchId}`)?.value);
  const b = parseInt(document.getElementById(`sb-${matchId}`)?.value);
  if (isNaN(a) || isNaN(b)) return;
  const result = a > b ? 'A' : b > a ? 'B' : 'draw';
  selectResult(matchId, result);
}

export function selectResult(matchId, result) {
  ['A', 'draw', 'B'].forEach(r => {
    const key = r === 'A' ? 'ra' : r === 'draw' ? 'rd' : 'rb';
    const btn = document.getElementById(`${key}-${matchId}`);
    if (btn) btn.classList.toggle('selected', r === result);
  });
}

export async function savePrediction(matchId) {
  const saEl = document.getElementById(`sa-${matchId}`);
  const sbEl = document.getElementById(`sb-${matchId}`);
  const sa = parseInt(saEl?.value);
  const sb = parseInt(sbEl?.value);

  if (isNaN(sa) || isNaN(sb)) {
    alert('Preencha o placar antes de salvar.'); return;
  }

  const result = sa > sb ? 'A' : sb > sa ? 'B' : 'draw';
  selectResult(matchId, result);

  try {
    const res = await apiFetch('/api/predictions', {
      method: 'POST',
      body: JSON.stringify({ userId: getCurrentUser().id, matchId, predictedScoreA: sa, predictedScoreB: sb, predictedResult: result })
    });
    if (!res.ok) { const d = await res.json(); alert(d.error); return; }

    const existing = getUserPredictions().findIndex(p => p.match_id === matchId);
    const obj = { match_id: matchId, predicted_score_a: sa, predicted_score_b: sb, predicted_result: result, points: 0 };
    const predictions = getUserPredictions();
    if (existing >= 0) predictions[existing] = { ...predictions[existing], ...obj };
    else predictions.push(obj);
    setUserPredictions(predictions);

    const btn = document.querySelector(`[onclick="savePrediction(${matchId})"]`);
    if (btn) { btn.textContent = '✅ Salvo!'; btn.style.background = 'var(--success)'; setTimeout(() => { btn.textContent = '💾 Salvar palpite'; btn.style.background = ''; }, 1500); }
  } catch (_) { alert('Erro ao salvar palpite.'); }
}

// ── Admin functions ───────────────────────────────────────────────
export function buildAdminList() {
  document.getElementById('admin-matches-list').innerHTML = getAllMatches().map(m => {
    const matchDate = new Date(m.match_date);
    const now = new Date();
    const locked = now >= new Date(matchDate.getTime() - 60 * 60 * 1000);
    const disabledStr = locked ? 'disabled' : '';

    return `
      <div class="admin-match-row ${locked ? 'locked' : ''}">
        <span class="admin-team right">${flagToEmoji(m.team_a_flag)} ${m.team_a}</span>
        <input type="number" class="admin-score-input" min="0" id="adm-a-${m.id}"
               value="${m.score_a ?? ''}" ${disabledStr} placeholder="-">
        <span style="font-weight:700;color:var(--muted)">×</span>
        <input type="number" class="admin-score-input" min="0" id="adm-b-${m.id}"
               value="${m.score_b ?? ''}" ${disabledStr} placeholder="-">
        <span class="admin-team">${m.team_b} ${flagToEmoji(m.team_b_flag)}</span>
      </div>
    `;
  }).join('');
}

export async function saveScores() {
  const updates = getAllMatches()
    .map(m => {
      const a = document.getElementById(`adm-a-${m.id}`)?.value;
      const b = document.getElementById(`adm-b-${m.id}`)?.value;
      return a !== '' && b !== '' ? { id: m.id, scoreA: parseInt(a), scoreB: parseInt(b) } : null;
    })
    .filter(Boolean);

  if (!updates.length) { alert('Nenhum placar para salvar.'); return; }

  try {
    const res = await apiFetch('/api/matches/update-scores', {
      method: 'POST',
      body: JSON.stringify({ matches: updates })
    });
    const d = await res.json();
    alert(res.ok ? d.message : d.error);
    if (res.ok) await loadMatches();
  } catch (_) { alert('Erro ao salvar placares.'); }
}

export async function fetchFromAPI() {
  try {
    const res = await apiFetch('/api/matches/fetch-results', { method: 'POST' });
    const d = await res.json();
    alert(res.ok ? d.message : d.error);
    if (res.ok) await loadMatches();
  } catch (_) { alert('Erro ao buscar dados da API.'); }
}

export async function syncWorldCup2026() {
  const confirm1 = confirm('⚠️ ATENÇÃO CRÍTICA!\n\nEsta ação irá:\n- EXCLUIR TODOS os jogos existentes\n- EXCLUIR TODOS os palpites dos usuários\n- Importar novos dados da Copa do Mundo FIFA 2026\n\nTem certeza que deseja continuar?');
  
  if (!confirm1) return;
  
  const confirm2 = confirm('🚨 ÚLTIMA CONFIRMAÇÃO!\n\nVocê está prestes a apagar PERMANENTEMENTE todos os dados do bolão.\n\nEsta ação NÃO PODE ser desfeita!\n\nClique em OK apenas se tiver certeza absoluta.');
  
  if (!confirm2) return;
  
  try {
    showLoading('Sincronizando Copa do Mundo 2026...');
    const res = await apiFetch('/api/matches/sync-world-cup-2026', { method: 'POST' });
    const d = await res.json();
    
    hideLoading();
    
    if (res.ok) {
      alert(`✅ ${d.message}\n\n${d.warning}`);
      await loadMatches();
      await loadRanking();
    } else {
      alert(`❌ Erro: ${d.error}`);
    }
  } catch (error) {
    hideLoading();
    alert('❌ Erro crítico ao sincronizar com a API. Verifique o console para mais detalhes.');
    console.error('Erro na sincronização:', error);
  }
}

// ── Admin: Pending Users Activation ───────────────────────────────
export async function loadPendingUsers() {
  try {
    const res = await apiFetch('/api/users/pending-activation');
    const users = await res.json();
    
    const container = document.getElementById('pending-users-list');
    
    if (!users || users.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">✅</div><p>Nenhum usuário pendente nas últimas 48h</p></div>';
      return;
    }
    
    container.innerHTML = users.map(u => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid #eee;">
        <div>
          <div style="font-weight:600;color:var(--navy);">${escapeHtml(u.name)}</div>
          <div style="font-size:.8rem;color:var(--muted);">${escapeHtml(u.email)}</div>
          <div style="font-size:.75rem;color:var(--muted);">Cadastro: ${new Date(u.created_at).toLocaleString('pt-BR')}</div>
        </div>
        <button class="btn btn-secondary" onclick="activateUser(${u.id})" style="padding:6px 12px;font-size:.8rem;">
          ✅ Ativar
        </button>
      </div>
    `).join('');
  } catch (_) {
    document.getElementById('pending-users-list').innerHTML = '<div class="empty-state"><div class="icon">❌</div><p>Erro ao carregar usuários pendentes</p></div>';
  }
}

export async function activateUser(userId) {
  try {
    const res = await apiFetch(`/api/users/activate/${userId}`, { method: 'POST' });
    const d = await res.json();
    
    if (res.ok) {
      alert(d.message);
      loadPendingUsers();
    } else {
      alert(d.error || 'Erro ao ativar usuário');
    }
  } catch (_) {
    alert('Erro ao ativar usuário');
  }
}

export async function activateAllPending() {
  if (!confirm('Tem certeza que deseja ativar TODOS os usuários pendentes das últimas 48 horas?')) {
    return;
  }
  
  try {
    const res = await apiFetch('/api/users/activate-all-pending', { method: 'POST' });
    const d = await res.json();
    
    if (res.ok) {
      alert(`${d.activatedCount || 0} usuário(s) ativado(s) com sucesso!`);
      loadPendingUsers();
    } else {
      alert(d.error || 'Erro ao ativar usuários');
    }
  } catch (_) {
    alert('Erro ao ativar usuários');
  }
}
