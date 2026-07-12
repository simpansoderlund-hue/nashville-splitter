// ---------- Setup ----------
// 1. Deploy the Apps Script in apps-script/Code.gs as a Web App (see README.md).
// 2. Paste the resulting /exec URL below.
// 3. Pick the same SHARED_KEY here and in Code.gs (a shared secret, not real security —
//    anyone who views this page's source can read it, same as the URL below).

const API_URL = 'https://script.google.com/macros/s/AKfycbyms1XgD2wSEpHbpNaLUrda-MZFCrB1TMYcDwEdTgIdPxjrfNPXrlp39ZBepk0e5E0t3A/exec';
const SHARED_KEY = 'nashville-yeehaw';

const state = {
  people: [],
  expenses: [],
  log: [],
  gameScores: [],
  reactionScores: [],
};

let currentUserName = null;

if (API_URL.includes('PASTE_YOUR')) {
  document.getElementById('setup-warning').classList.remove('hidden');
}

// ---------- Backend calls ----------

// Reads are a plain GET — the Apps Script /exec endpoint returns JSON and is
// readable cross-origin, so no special handling is needed here.
async function refreshData() {
  const res = await fetch(API_URL, { method: 'GET' });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  state.people = data.people || [];
  state.expenses = data.expenses.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.log = data.log || [];
  state.gameScores = data.gameScores || [];
  state.reactionScores = data.reactionScores || [];
  return data;
}

// Writes are a POST with a form-encoded body (URLSearchParams), which stays a
// CORS "simple request" and avoids the preflight issues Apps Script doesn't
// handle well. If the browser still can't read the response for some reason
// (e.g. a stricter network setup), we fall back to a fire-and-forget no-cors
// POST and just re-fetch the data afterward.
async function callAction(action, data) {
  const body = new URLSearchParams({ action, key: SHARED_KEY, data: JSON.stringify(data) });
  try {
    const res = await fetch(API_URL, { method: 'POST', body });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  } catch (err) {
    if (err instanceof TypeError) {
      // Likely a CORS/network-level failure reading the response, not a
      // rejected action — retry blind and let the caller re-fetch state.
      await fetch(API_URL, { method: 'POST', body, mode: 'no-cors' });
      return null;
    }
    throw err;
  }
}

// ---------- Who are you? (name gate) ----------
// Every visitor picks their name from the People sheet before using the app.
// Matching is case-insensitive, and it's remembered per-browser afterward so
// it only asks once. If the typed name isn't on the sheet yet, it offers to
// add them as a new person (so this doesn't create a chicken-and-egg problem
// for the very first person to open the app).

const NAME_STORAGE_KEY = 'tripSplitterName';

function getSavedName() {
  return localStorage.getItem(NAME_STORAGE_KEY);
}

function saveName(name) {
  localStorage.setItem(NAME_STORAGE_KEY, name);
}

function clearSavedName() {
  localStorage.removeItem(NAME_STORAGE_KEY);
}

function updateWhoamiBadge() {
  const badge = document.getElementById('whoami-badge');
  const label = document.getElementById('whoami-label');
  if (currentUserName) {
    label.textContent = `${avatarFor(currentUserName)} ${currentUserName}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function ensureIdentified() {
  try {
    await refreshData();
  } catch (e) {
    console.error(e);
  }

  const saved = getSavedName();
  const savedMatch = saved && state.people.find(p => p.name.toLowerCase() === saved.toLowerCase());
  if (savedMatch) return savedMatch.name;

  const overlay = document.getElementById('name-gate');
  const form = document.getElementById('name-gate-form');
  const input = document.getElementById('name-gate-input');
  const errorEl = document.getElementById('name-gate-error');
  const addBtn = document.getElementById('name-gate-add');

  overlay.classList.remove('hidden');
  addBtn.classList.add('hidden');
  errorEl.textContent = '';
  input.focus();

  return new Promise(resolve => {
    function finish(name) {
      saveName(name);
      overlay.classList.add('hidden');
      form.removeEventListener('submit', onSubmit);
      addBtn.removeEventListener('click', onAdd);
      resolve(name);
    }

    function onSubmit(e) {
      e.preventDefault();
      const entered = input.value.trim();
      if (!entered) return;
      const match = state.people.find(p => p.name.toLowerCase() === entered.toLowerCase());
      if (match) {
        finish(match.name);
        return;
      }
      errorEl.textContent = `No one named "${entered}" yet.`;
      addBtn.textContent = `Add me as "${entered}"`;
      addBtn.classList.remove('hidden');
    }

    async function onAdd() {
      const entered = input.value.trim();
      if (!entered) return;
      errorEl.textContent = '';
      addBtn.disabled = true;
      try {
        const created = await callAction('addPerson', { name: entered });
        await refreshData();
        finish(created.name);
      } catch (err) {
        errorEl.textContent = err.message;
      } finally {
        addBtn.disabled = false;
      }
    }

    form.addEventListener('submit', onSubmit);
    addBtn.addEventListener('click', onAdd);
  });
}

document.getElementById('whoami-badge').addEventListener('click', async () => {
  clearSavedName();
  currentUserName = null;
  updateWhoamiBadge();
  currentUserName = await ensureIdentified();
  updateWhoamiBadge();
  renderPaidBySelect();
});

// ---------- Tabs ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    await loadForTab(btn.dataset.tab);
  });
});

async function loadForTab(tab) {
  try {
    await refreshData();
  } catch (e) {
    console.error(e);
  }
  renderPeopleList();
  renderPaidBySelect();
  renderParticipantCheckboxes();
  if (tab === 'expenses') renderExpenses();
  if (tab === 'balances') renderBalancesAndSettleUp();
}

// ---------- Helpers ----------

function money(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function nameOf(id) {
  const p = state.people.find(p => p.id === id);
  return p ? p.name : 'Unknown';
}

// ---------- Avatars ----------
// A little emoji next to each person's name — picked deterministically from
// the name itself, so the same person always gets the same emoji.

const AVATAR_EMOJIS = ['🦊', '🐻', '🐼', '🐨', '🐸', '🦁', '🐯', '🐵', '🐶', '🐱', '🐰', '🦄', '🐷', '🐮', '🐔', '🦉', '🐙', '🦋', '🐝', '🐳', '🐢', '🦖', '🐧', '🦔'];

function avatarFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_EMOJIS[hash % AVATAR_EMOJIS.length];
}

function avatarHtml(name) {
  return `<span class="avatar" title="${escapeHtml(name)}">${avatarFor(name)}</span>`;
}

function setDefaultDate() {
  const dateInput = document.getElementById('exp-date');
  dateInput.value = new Date().toISOString().slice(0, 10);
}

// ---------- People ----------

function renderPeopleList() {
  const container = document.getElementById('people-list');
  if (state.people.length === 0) {
    container.innerHTML = '<p class="empty-state">No one added yet. Add your friends above.</p>';
    return;
  }
  container.innerHTML = state.people.map(p => `
    <div class="person-row">
      <span>${avatarHtml(p.name)}${escapeHtml(p.name)}</span>
    </div>
  `).join('');
}

function renderPaidBySelect() {
  const select = document.getElementById('exp-paid-by');
  const prev = select.value;
  select.innerHTML = state.people.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (state.people.some(p => p.id === prev)) {
    select.value = prev;
  } else if (currentUserName) {
    const me = state.people.find(p => p.name.toLowerCase() === currentUserName.toLowerCase());
    if (me) select.value = me.id;
  }
}

function renderParticipantCheckboxes() {
  const container = document.getElementById('participant-checkboxes');
  container.innerHTML = state.people.map(p => `
    <label>
      <input type="checkbox" value="${p.id}" checked />
      ${avatarHtml(p.name)}${escapeHtml(p.name)}
    </label>
  `).join('');
}

document.getElementById('select-all-btn').addEventListener('click', () => {
  document.querySelectorAll('#participant-checkboxes input[type="checkbox"]').forEach(cb => cb.checked = true);
});
document.getElementById('select-none-btn').addEventListener('click', () => {
  document.querySelectorAll('#participant-checkboxes input[type="checkbox"]').forEach(cb => cb.checked = false);
});

document.getElementById('person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('person-name');
  const errorEl = document.getElementById('person-error');
  errorEl.textContent = '';
  try {
    await callAction('addPerson', { name: input.value });
    input.value = '';
    await refreshData();
    renderPeopleList();
    renderPaidBySelect();
    renderParticipantCheckboxes();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Add expense form ----------

document.getElementById('expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('add-error');
  errorEl.textContent = '';

  const description = document.getElementById('exp-description').value;
  const amount = document.getElementById('exp-amount').value;
  const date = document.getElementById('exp-date').value;
  const paidBy = document.getElementById('exp-paid-by').value;
  const participantIds = Array.from(
    document.querySelectorAll('#participant-checkboxes input[type="checkbox"]:checked')
  ).map(cb => cb.value);

  if (state.people.length === 0) {
    errorEl.textContent = 'Add at least one person first (People tab).';
    return;
  }
  if (!paidBy) {
    errorEl.textContent = 'Choose who paid.';
    return;
  }
  if (participantIds.length === 0) {
    errorEl.textContent = 'Select at least one person to split with.';
    return;
  }

  try {
    await callAction('addExpense', { description, amount, date, paidBy, participantIds });
    document.getElementById('expense-form').reset();
    setDefaultDate();
    renderParticipantCheckboxes();
    errorEl.textContent = '';
    showSuccess(`✅ "${description}" (${money(Number(amount))}) added!`);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Expenses list ----------

function renderExpenses() {
  const container = document.getElementById('expenses-list');
  if (state.expenses.length === 0) {
    container.innerHTML = '<p class="empty-state">No expenses yet. Add one in the Add Expense tab.</p>';
    return;
  }
  container.innerHTML = state.expenses.map(exp => `
    <div class="card${exp.isSettlement ? ' settlement' : ''}">
      <div class="card-row">
        <div>
          <div class="card-title">${
            exp.isSettlement
              ? `🤝 ${escapeHtml(nameOf(exp.paidBy))} paid ${escapeHtml(nameOf(exp.participantIds[0]))}`
              : escapeHtml(exp.description)
          }</div>
          <div class="card-sub">
            ${
              exp.isSettlement
                ? `${exp.date} &middot; settlement`
                : `${exp.date} &middot; paid by ${escapeHtml(nameOf(exp.paidBy))}<br/>
            split: ${exp.participantIds.map(id => escapeHtml(nameOf(id))).join(', ')}`
            }
          </div>
        </div>
        <div style="text-align:right">
          <div class="card-amount">${money(exp.amount)}</div>
        </div>
      </div>
    </div>
  `).join('');
}

// ---------- Balances (computed client-side from people + expenses) ----------
// Same math as the original app's server-side /api/balances endpoint.

function computeBalances() {
  const balances = {};
  state.people.forEach(p => { balances[p.id] = 0; });

  for (const expense of state.expenses) {
    const share = expense.amount / expense.participantIds.length;
    for (const pid of expense.participantIds) {
      if (balances[pid] === undefined) balances[pid] = 0;
      balances[pid] -= share;
    }
    if (balances[expense.paidBy] === undefined) balances[expense.paidBy] = 0;
    balances[expense.paidBy] += expense.amount;
  }

  const net = state.people.map(p => ({
    id: p.id,
    name: p.name,
    amount: Math.round((balances[p.id] || 0) * 100) / 100,
  }));

  return { balances: net, transactions: simplifyDebts(net) };
}

function simplifyDebts(balances) {
  const EPSILON = 0.005;
  const creditors = balances
    .filter(b => b.amount > EPSILON)
    .map(b => ({ ...b }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = balances
    .filter(b => b.amount < -EPSILON)
    .map(b => ({ ...b, amount: -b.amount }))
    .sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    transactions.push({
      fromId: debtors[i].id,
      from: debtors[i].name,
      toId: creditors[j].id,
      to: creditors[j].name,
      amount: Math.round(pay * 100) / 100,
    });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount <= EPSILON) i++;
    if (creditors[j].amount <= EPSILON) j++;
  }
  return transactions;
}

function renderBalancesAndSettleUp() {
  const { balances, transactions } = computeBalances();
  renderBalances(balances);
  renderSettleUp(transactions);
}

function renderBalances(balances) {
  const container = document.getElementById('balances-list');
  if (balances.length === 0) {
    container.innerHTML = '<p class="empty-state">Add people and expenses to see balances.</p>';
    return;
  }
  container.innerHTML = balances.map(b => {
    const cls = b.amount > 0.005 ? 'positive' : b.amount < -0.005 ? 'negative' : 'zero';
    const label = b.amount > 0.005 ? 'is owed' : b.amount < -0.005 ? 'owes' : 'is settled up';
    return `
      <div class="balance-row">
        <span>${avatarHtml(b.name)}${escapeHtml(b.name)}</span>
        <span class="balance-amount ${cls}">${label} ${money(Math.abs(b.amount))}</span>
      </div>
    `;
  }).join('');
}

function renderSettleUp(transactions) {
  const container = document.getElementById('settle-list');
  if (transactions.length === 0) {
    container.innerHTML = '<p class="empty-state">Everyone is settled up! 🎉</p>';
    return;
  }
  container.innerHTML = transactions.map((t, i) => `
    <button type="button" class="settle-row" data-index="${i}">
      <span><strong>${avatarHtml(t.from)}${escapeHtml(t.from)}</strong> pays <strong>${avatarHtml(t.to)}${escapeHtml(t.to)}</strong></span>
      <span class="settle-amount">${money(t.amount)}</span>
    </button>
  `).join('');

  container.querySelectorAll('.settle-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = transactions[Number(btn.dataset.index)];
      const ok = await confirmDialog(
        `Are you sure ${t.from} paid ${t.to} ${money(t.amount)}?`,
        { okLabel: 'Mark as Paid', okClass: 'btn-confirm' }
      );
      if (!ok) return;
      try {
        await callAction('settle', { fromId: t.fromId, toId: t.toId, amount: t.amount });
        await refreshData();
        renderBalancesAndSettleUp();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

// ---------- Confirm modal ----------

function confirmDialog(message, { okLabel = 'Confirm', okClass = 'btn-confirm' } = {}) {
  const overlay = document.getElementById('confirm-overlay');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  document.getElementById('confirm-message').textContent = message;
  okBtn.textContent = okLabel;
  okBtn.className = okClass;
  overlay.classList.remove('hidden');

  return new Promise(resolve => {
    function cleanup(result) {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === overlay) cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
  });
}

// ---------- Success confirmation ----------

function showSuccess(message, autoCloseMs = 2000) {
  const overlay = document.getElementById('success-overlay');
  const okBtn = document.getElementById('success-ok');
  document.getElementById('success-message').textContent = message;
  overlay.classList.remove('hidden');

  function close() {
    overlay.classList.add('hidden');
    okBtn.removeEventListener('click', close);
    overlay.removeEventListener('click', onOverlayClick);
    clearTimeout(timer);
  }
  function onOverlayClick(e) { if (e.target === overlay) close(); }

  okBtn.addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);
  const timer = setTimeout(close, autoCloseMs);
}

// ---------- Guitar easter egg mini-game ----------
// Whack-a-Taylor: click her before she moves to the next cell. Sometimes a
// 🤖 Ticketmaster bot shows up instead — click that one by mistake and it's
// -2 points. Scores are saved to the sheet (per identified person) so
// everyone can see who got what.

const GAME_DURATION_SECONDS = 15;
const GAME_CELL_COUNT = 9;
const GAME_SPAWN_MS = 800;
const GAME_DECOY_EMOJI = '🤖';
const GAME_DECOY_CHANCE = 0.25;
const GAME_DECOY_PENALTY = 2;

let gameState = null; // { score, timeLeft, activeCell, activeIsDecoy, spawnTimer, tickTimer }

const GAME_RESULT_LINES = [
  "still not enough to cover the Eras Tour merch debt.",
  "Taylor Swift is impressed, but unpaid.",
  "somebody on the Balances tab still owes for merch.",
  "add it to the tab — right next to the friendship bracelets.",
];

function buildGameGrid() {
  const grid = document.getElementById('game-grid');
  grid.innerHTML = '';
  for (let i = 0; i < GAME_CELL_COUNT; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'game-cell';
    cell.dataset.index = String(i);
    grid.appendChild(cell);
  }
}

function onGameGridClick(e) {
  const cell = e.target.closest('.game-cell');
  if (!cell || !gameState) return;

  // A hit scores (or penalizes, for the decoy); a miss scores nothing — but
  // either way the target immediately relocates, so you can't just spam-click
  // the whole grid.
  if (Number(cell.dataset.index) === gameState.activeCell) {
    gameState.score += gameState.activeIsDecoy ? -GAME_DECOY_PENALTY : 1;
    document.getElementById('game-score').textContent = String(gameState.score);
  }
  spawnMole();
}

function spawnMole() {
  if (!gameState) return;
  document.querySelectorAll('.game-cell').forEach(c => {
    c.classList.remove('active', 'decoy');
    c.textContent = '';
  });
  const idx = Math.floor(Math.random() * GAME_CELL_COUNT);
  const isDecoy = Math.random() < GAME_DECOY_CHANCE;
  gameState.activeCell = idx;
  gameState.activeIsDecoy = isDecoy;
  const cell = document.querySelector(`.game-cell[data-index="${idx}"]`);
  cell.classList.add('active');
  if (isDecoy) cell.classList.add('decoy');
  cell.textContent = isDecoy ? GAME_DECOY_EMOJI : '🎤';
}

function startGuitarGame() {
  buildGameGrid();
  document.getElementById('game-intro').classList.add('hidden');
  document.getElementById('game-result').classList.add('hidden');
  document.getElementById('game-start-btn').classList.add('hidden');
  document.getElementById('game-leaderboard').classList.add('hidden');
  document.getElementById('game-hud').classList.remove('hidden');
  document.getElementById('game-grid').classList.remove('hidden');

  gameState = { score: 0, timeLeft: GAME_DURATION_SECONDS, activeCell: null, activeIsDecoy: false };
  document.getElementById('game-score').textContent = '0';
  document.getElementById('game-time').textContent = String(GAME_DURATION_SECONDS);

  spawnMole();
  gameState.spawnTimer = setInterval(spawnMole, GAME_SPAWN_MS);
  gameState.tickTimer = setInterval(() => {
    gameState.timeLeft--;
    document.getElementById('game-time').textContent = String(gameState.timeLeft);
    if (gameState.timeLeft <= 0) endGuitarGame();
  }, 1000);
}

async function endGuitarGame() {
  if (!gameState) return;
  clearInterval(gameState.spawnTimer);
  clearInterval(gameState.tickTimer);
  const score = gameState.score;
  gameState = null;

  document.getElementById('game-grid').classList.add('hidden');
  document.getElementById('game-hud').classList.add('hidden');

  // Modulo can go negative in JS when score is negative — normalize the index.
  const line = GAME_RESULT_LINES[((score % GAME_RESULT_LINES.length) + GAME_RESULT_LINES.length) % GAME_RESULT_LINES.length];
  const resultEl = document.getElementById('game-result');
  resultEl.textContent = `🎤 Final score: ${score}! That's ${line}`;
  resultEl.classList.remove('hidden');

  const startBtn = document.getElementById('game-start-btn');
  startBtn.textContent = 'Play again';
  startBtn.classList.remove('hidden');

  if (currentUserName) {
    try {
      await callAction('addGameScore', { name: currentUserName, score });
      await refreshData();
    } catch (e) {
      console.error(e);
    }
  }
  renderLeaderboard('game-leaderboard', state.gameScores);
  document.getElementById('game-leaderboard').classList.remove('hidden');
}

// Shared by every mini-game's leaderboard: keep only each person's best
// score (so one person can't occupy every spot), then take the top N.
function topScoresByPerson(scores, limit = 5) {
  const bestByPerson = new Map();
  for (const s of scores) {
    const key = s.name.toLowerCase();
    const existing = bestByPerson.get(key);
    if (!existing || s.score > existing.score) bestByPerson.set(key, s);
  }
  return Array.from(bestByPerson.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

function renderLeaderboard(containerId, scores) {
  const container = document.getElementById(containerId);
  if (!scores.length) {
    container.innerHTML = '';
    return;
  }
  const top5 = topScoresByPerson(scores);
  container.innerHTML = `
    <p class="hint" style="margin-bottom: 6px">🏆 Top 5 scores</p>
    ${top5.map(s => `
      <div class="balance-row">
        <span>${avatarHtml(s.name)}${escapeHtml(s.name)}</span>
        <span>${s.score} pts</span>
      </div>
    `).join('')}
  `;
}

function resetGuitarGameView() {
  if (gameState) {
    clearInterval(gameState.spawnTimer);
    clearInterval(gameState.tickTimer);
    gameState = null;
  }
  document.getElementById('game-intro').classList.remove('hidden');
  document.getElementById('game-result').classList.add('hidden');
  document.getElementById('game-hud').classList.add('hidden');
  document.getElementById('game-grid').classList.add('hidden');
  document.getElementById('game-leaderboard').classList.remove('hidden');
  const startBtn = document.getElementById('game-start-btn');
  startBtn.textContent = 'Start';
  startBtn.classList.remove('hidden');
}

function closeGuitarGame() {
  resetGuitarGameView();
  document.getElementById('guitar-game-overlay').classList.add('hidden');
}

document.getElementById('guitar-badge').addEventListener('click', async () => {
  document.getElementById('guitar-game-overlay').classList.remove('hidden');
  try {
    await refreshData();
  } catch (e) {
    console.error(e);
  }
  renderLeaderboard('game-leaderboard', state.gameScores);
});
document.getElementById('game-grid').addEventListener('click', onGameGridClick);
document.getElementById('game-start-btn').addEventListener('click', startGuitarGame);
document.getElementById('game-close').addEventListener('click', closeGuitarGame);
document.getElementById('guitar-game-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeGuitarGame();
});

// ---------- Reaction easter egg mini-game ("Quick Draw") ----------
// Wait for the button to turn green, then click as fast as possible. Click
// while it's still red (waiting) and that's a jumped-the-gun miss. Faster
// clicks on green score more. Same 15s-timer/leaderboard shape as the guitar
// game, but a completely different mechanic — timing/reflexes, not spatial.

const REACTION_DURATION_SECONDS = 15;
const REACTION_MIN_DELAY_MS = 1000;
const REACTION_MAX_DELAY_MS = 3500;
const REACTION_EARLY_PENALTY = 1;
const REACTION_POINT_STEP_MS = 100; // one point per 100ms faster than the cap
const REACTION_POINT_CAP_MS = 1000; // reactions at/above this score 0

let reactionState = null; // { score, timeLeft, phase, readyAt, roundTimeout, tickTimer }

function startReactionRound() {
  if (!reactionState) return;
  const btn = document.getElementById('reaction-btn');
  reactionState.phase = 'waiting';
  btn.textContent = 'Wait…';
  btn.classList.remove('ready');
  btn.classList.add('waiting');

  const delay = REACTION_MIN_DELAY_MS + Math.random() * (REACTION_MAX_DELAY_MS - REACTION_MIN_DELAY_MS);
  reactionState.roundTimeout = setTimeout(() => {
    if (!reactionState) return;
    reactionState.phase = 'ready';
    reactionState.readyAt = performance.now();
    btn.textContent = 'Click now!';
    btn.classList.remove('waiting');
    btn.classList.add('ready');
  }, delay);
}

function onReactionBtnClick() {
  if (!reactionState) return;
  const feedbackEl = document.getElementById('reaction-feedback');

  if (reactionState.phase === 'waiting') {
    clearTimeout(reactionState.roundTimeout);
    reactionState.score -= REACTION_EARLY_PENALTY;
    feedbackEl.textContent = `Too soon! -${REACTION_EARLY_PENALTY}`;
  } else {
    const elapsed = performance.now() - reactionState.readyAt;
    const points = Math.max(0, Math.round((REACTION_POINT_CAP_MS - elapsed) / REACTION_POINT_STEP_MS));
    reactionState.score += points;
    feedbackEl.textContent = `${Math.round(elapsed)}ms — +${points}`;
  }

  document.getElementById('reaction-score').textContent = String(reactionState.score);
  startReactionRound();
}

function startReactionGame() {
  document.getElementById('reaction-intro').classList.add('hidden');
  document.getElementById('reaction-result').classList.add('hidden');
  document.getElementById('reaction-start-btn').classList.add('hidden');
  document.getElementById('reaction-leaderboard').classList.add('hidden');
  document.getElementById('reaction-hud').classList.remove('hidden');
  document.getElementById('reaction-feedback').classList.remove('hidden');
  document.getElementById('reaction-btn').classList.remove('hidden');

  reactionState = { score: 0, timeLeft: REACTION_DURATION_SECONDS, phase: null, readyAt: 0, roundTimeout: null, tickTimer: null };
  document.getElementById('reaction-score').textContent = '0';
  document.getElementById('reaction-time').textContent = String(REACTION_DURATION_SECONDS);
  document.getElementById('reaction-feedback').textContent = '';

  startReactionRound();
  reactionState.tickTimer = setInterval(() => {
    reactionState.timeLeft--;
    document.getElementById('reaction-time').textContent = String(reactionState.timeLeft);
    if (reactionState.timeLeft <= 0) endReactionGame();
  }, 1000);
}

async function endReactionGame() {
  if (!reactionState) return;
  clearInterval(reactionState.tickTimer);
  clearTimeout(reactionState.roundTimeout);
  const score = reactionState.score;
  reactionState = null;

  document.getElementById('reaction-btn').classList.add('hidden');
  document.getElementById('reaction-hud').classList.add('hidden');
  document.getElementById('reaction-feedback').classList.add('hidden');

  const resultEl = document.getElementById('reaction-result');
  resultEl.textContent = `⚡ Final score: ${score}! ${score >= 20 ? 'Fastest hands on the trip.' : 'Reflexes could use a fika break.'}`;
  resultEl.classList.remove('hidden');

  const startBtn = document.getElementById('reaction-start-btn');
  startBtn.textContent = 'Play again';
  startBtn.classList.remove('hidden');

  if (currentUserName) {
    try {
      await callAction('addReactionScore', { name: currentUserName, score });
      await refreshData();
    } catch (e) {
      console.error(e);
    }
  }
  renderLeaderboard('reaction-leaderboard', state.reactionScores);
  document.getElementById('reaction-leaderboard').classList.remove('hidden');
}

function resetReactionGameView() {
  if (reactionState) {
    clearInterval(reactionState.tickTimer);
    clearTimeout(reactionState.roundTimeout);
    reactionState = null;
  }
  document.getElementById('reaction-intro').classList.remove('hidden');
  document.getElementById('reaction-result').classList.add('hidden');
  document.getElementById('reaction-hud').classList.add('hidden');
  document.getElementById('reaction-btn').classList.add('hidden');
  document.getElementById('reaction-feedback').classList.add('hidden');
  document.getElementById('reaction-leaderboard').classList.remove('hidden');
  const startBtn = document.getElementById('reaction-start-btn');
  startBtn.textContent = 'Start';
  startBtn.classList.remove('hidden');
}

function closeReactionGame() {
  resetReactionGameView();
  document.getElementById('reaction-game-overlay').classList.add('hidden');
}

document.getElementById('reaction-game-badge').addEventListener('click', async () => {
  document.getElementById('reaction-game-overlay').classList.remove('hidden');
  try {
    await refreshData();
  } catch (e) {
    console.error(e);
  }
  renderLeaderboard('reaction-leaderboard', state.reactionScores);
});
document.getElementById('reaction-btn').addEventListener('click', onReactionBtnClick);
document.getElementById('reaction-start-btn').addEventListener('click', startReactionGame);
document.getElementById('reaction-close').addEventListener('click', closeReactionGame);
document.getElementById('reaction-game-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeReactionGame();
});

// ---------- Activity log ----------

document.getElementById('log-badge').addEventListener('click', openActivityLog);

async function openActivityLog() {
  const overlay = document.getElementById('log-overlay');
  const content = document.getElementById('log-content');
  content.textContent = 'Loading...';
  overlay.classList.remove('hidden');
  try {
    await refreshData();
    content.textContent = state.log.length ? state.log.join('\n') : 'No activity logged yet.';
  } catch (e) {
    content.textContent = `Couldn't load the log: ${e.message}`;
  }
}

function closeActivityLog() {
  document.getElementById('log-overlay').classList.add('hidden');
}

document.getElementById('log-close').addEventListener('click', closeActivityLog);
document.getElementById('log-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeActivityLog();
});

// ---------- Init ----------

async function init() {
  setDefaultDate();
  if (!API_URL.includes('PASTE_YOUR')) {
    currentUserName = await ensureIdentified();
    updateWhoamiBadge();
  }
  await loadForTab('add');
}

init();
