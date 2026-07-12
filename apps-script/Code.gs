// Paste this whole file into the Apps Script editor (Extensions > Apps Script)
// of the Google Sheet you want to use as the database. See README.md for the
// full deployment walkthrough.
//
// This intentionally has NO delete endpoints for people or expenses — fixing
// a mistake means editing the sheet by hand (or clearing the "removed" style
// cell if you add one yourself). That keeps the script simple and means the
// spreadsheet itself is always the ground truth, editable directly.

const SHARED_KEY = 'nashville-yeehaw'; // must match SHARED_KEY in app.js

const SHEETS = {
  people: { name: 'People', headers: ['id', 'name', 'addedAt'] },
  expenses: { name: 'Expenses', headers: ['id', 'description', 'amount', 'paidBy', 'date', 'participantIds', 'createdAt', 'isSettlement'] },
  log: { name: 'Log', headers: ['timestamp', 'message'] },
  gameScores: { name: 'GameScores', headers: ['name', 'score', 'playedAt'] },
  reactionScores: { name: 'ReactionScores', headers: ['name', 'score', 'playedAt'] },
};

function getSheet(key) {
  const cfg = SHEETS[key];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(cfg.name);
  if (!sheet) {
    sheet = ss.insertSheet(cfg.name);
    sheet.appendRow(cfg.headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normDate(v) {
  return v instanceof Date ? v.toISOString() : v;
}

// ---------- Reads ----------

function readPeople() {
  const rows = getSheet('people').getDataRange().getValues();
  return rows.slice(1)
    .filter(r => r[0])
    .map(r => ({ id: r[0], name: r[1], addedAt: normDate(r[2]) }));
}

function readExpenses() {
  const rows = getSheet('expenses').getDataRange().getValues();
  return rows.slice(1)
    .filter(r => r[0])
    .map(r => ({
      id: r[0],
      description: r[1],
      amount: Number(r[2]),
      paidBy: r[3],
      date: normDate(r[4]),
      participantIds: JSON.parse(r[5] || '[]'),
      createdAt: normDate(r[6]),
      isSettlement: r[7] === true || r[7] === 'TRUE',
    }));
}

function readLog() {
  const rows = getSheet('log').getDataRange().getValues();
  return rows.slice(1)
    .filter(r => r[0])
    .map(r => `[${normDate(r[0])}] ${r[1]}`)
    .reverse()
    .slice(0, 200);
}

// Shared shape (name, score, playedAt) for every mini-game's score sheet.
function readScores(sheetKey) {
  const rows = getSheet(sheetKey).getDataRange().getValues();
  return rows.slice(1)
    .filter(r => r[0])
    .map(r => ({ name: r[0], score: Number(r[1]), playedAt: normDate(r[2]) }))
    .reverse()
    .slice(0, 50);
}

function log(message) {
  getSheet('log').appendRow([new Date().toISOString(), message]);
}

// ---------- Web app entry points ----------

function doGet(e) {
  return jsonResponse({
    people: readPeople(),
    expenses: readExpenses(),
    log: readLog(),
    gameScores: readScores('gameScores'),
    reactionScores: readScores('reactionScores'),
  });
}

function doPost(e) {
  const params = e.parameter;
  if (params.key !== SHARED_KEY) {
    return jsonResponse({ error: 'Unauthorized' });
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ error: 'Server busy, try again' });
  }

  try {
    const data = JSON.parse(params.data || '{}');
    switch (params.action) {
      case 'addPerson': return addPerson(data);
      case 'addExpense': return addExpense(data);
      case 'settle': return settle(data);
      case 'addGameScore': return addScore('gameScores', 'the guitar mini-game', data);
      case 'addReactionScore': return addScore('reactionScores', 'the reaction mini-game', data);
      default: return jsonResponse({ error: 'Unknown action' });
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------- Actions ----------

function addPerson(data) {
  const name = (data.name || '').trim();
  if (!name) return jsonResponse({ error: 'Name is required' });

  const people = readPeople();
  if (people.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return jsonResponse({ error: 'That person already exists' });
  }

  const id = Utilities.getUuid();
  const addedAt = new Date().toISOString();
  getSheet('people').appendRow([id, name, addedAt]);
  log(`PERSON_ADDED "${name}"`);
  return jsonResponse({ id, name, addedAt });
}

function addExpense(data) {
  const description = (data.description || '').trim();
  const amount = Number(data.amount);
  const paidBy = data.paidBy;
  const date = data.date || new Date().toISOString().slice(0, 10);
  const participantIds = Array.isArray(data.participantIds) ? data.participantIds : [];

  if (!description) return jsonResponse({ error: 'Description is required' });
  if (!amount || amount <= 0) return jsonResponse({ error: 'Amount must be a positive number' });
  if (!paidBy) return jsonResponse({ error: 'Payer is required' });
  if (participantIds.length === 0) return jsonResponse({ error: 'At least one participant is required' });

  const people = readPeople();
  const validIds = new Set(people.map(p => p.id));
  if (!validIds.has(paidBy) || !participantIds.every(id => validIds.has(id))) {
    return jsonResponse({ error: 'Unknown person referenced' });
  }

  const id = Utilities.getUuid();
  const createdAt = new Date().toISOString();
  const roundedAmount = Math.round(amount * 100) / 100;
  getSheet('expenses').appendRow([id, description, roundedAmount, paidBy, date, JSON.stringify(participantIds), createdAt, false]);

  const payerName = (people.find(p => p.id === paidBy) || {}).name || 'Unknown';
  log(`EXPENSE_ADDED "${description}" $${roundedAmount.toFixed(2)} paid by ${payerName}`);
  return jsonResponse({ id, description, amount: roundedAmount, paidBy, date, participantIds, createdAt, isSettlement: false });
}

// Records a settle-up payment as a special expense: paidBy the debtor, with the
// creditor as the sole participant — same trick server.js used, so the balance
// math on the frontend needs no special case for settlements.
function settle(data) {
  const fromId = data.fromId;
  const toId = data.toId;
  const amount = Number(data.amount);

  if (!fromId || !toId) return jsonResponse({ error: 'Both people are required' });
  if (fromId === toId) return jsonResponse({ error: 'A person cannot pay themselves' });
  if (!amount || amount <= 0) return jsonResponse({ error: 'Amount must be a positive number' });

  const people = readPeople();
  const from = people.find(p => p.id === fromId);
  const to = people.find(p => p.id === toId);
  if (!from || !to) return jsonResponse({ error: 'Unknown person referenced' });

  const id = Utilities.getUuid();
  const createdAt = new Date().toISOString();
  const date = createdAt.slice(0, 10);
  const roundedAmount = Math.round(amount * 100) / 100;
  const description = `${from.name} paid ${to.name}`;

  getSheet('expenses').appendRow([id, description, roundedAmount, fromId, date, JSON.stringify([toId]), createdAt, true]);
  log(`SETTLEMENT "${from.name}" paid "${to.name}" $${roundedAmount.toFixed(2)}`);
  return jsonResponse({ id, description, amount: roundedAmount, paidBy: fromId, date, participantIds: [toId], createdAt, isSettlement: true });
}

// Shared write path for any mini-game's score sheet — sheetKey picks the tab,
// gameLabel is just for the activity log message.
function addScore(sheetKey, gameLabel, data) {
  const name = (data.name || '').trim();
  const score = Number(data.score);
  if (!name) return jsonResponse({ error: 'Name is required' });
  if (!Number.isFinite(score)) return jsonResponse({ error: 'Score must be a number' });

  const playedAt = new Date().toISOString();
  getSheet(sheetKey).appendRow([name, score, playedAt]);
  log(`GAME_SCORE "${name}" scored ${score} in ${gameLabel}`);
  return jsonResponse({ name, score, playedAt });
}
