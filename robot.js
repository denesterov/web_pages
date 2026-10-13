(function () {
"use strict";

/* ============================================================
   Логика ВМ (порт robot_vm.py)
   ============================================================ */

class Command {
  constructor(cmd, args, codeLine, block) {
    this.cmd = cmd;
    this.args = args;
    this.codeLine = codeLine;
    this.block = block || null;
  }
}

class Code {
  constructor(sourceCode) {
    this.lines = sourceCode.split(/\r?\n/);
    const lower = this.lines.map(s => s.toLowerCase());
    const res = this._parseBlock(lower, 0, 0);
    this.block = res.block;
  }

  _parseBlock(source, blockIndent, startLine) {
    const block = [];
    let lnIdx = startLine;
    while (lnIdx < source.length) {
      const ln = source[lnIdx];
      const lnstr = ln.trim();
      if (lnstr.length === 0 || lnstr[0] === '#') { lnIdx++; continue; }

      const indent = ln.length - ln.replace(/^\s+/, '').length;
      if (indent < blockIndent) return { block, lnIdx };
      if (indent > blockIndent) {
        throw new Error(`Строка ${startLine + lnIdx + 1}: ожидался отступ ${blockIndent}, получен ${indent}`);
      }

      const words = ln.trim().split(/\s+/);
      const args = words.slice(1).join(' ');
      const cmd = new Command(words[0], args, lnIdx);

      if (cmd.cmd === 'если' || cmd.cmd === 'повтор') {
        const sub = this._parseBlock(source, blockIndent + 2, lnIdx + 1);
        cmd.block = sub.block;
        lnIdx = sub.lnIdx;
      } else {
        lnIdx++;
      }
      block.push(cmd);
    }
    return { block, lnIdx };
  }
}

class Field {
  constructor(textData) {
    const lines = textData.split(/\r?\n/);
    this.field = {};        // "x,y" -> 'X'
    this.bonuses = [];      // [{x,y}]
    this.start = null;
    this.finish = null;

    const d = lines[0].trim().toUpperCase();
    const DIRS = { 'L': [-1, 0], 'R': [+1, 0], 'U': [0, -1], 'D': [0, +1] };
    if (!(d in DIRS)) throw new Error('Направление может быть L, R, U или D');
    this.startDir = DIRS[d];

    let height = 0, width = 0;
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (ln === '') break;
      for (let j = 0; j < ln.length; j++) {
        const c = ln[j];
        const key = `${j},${height}`;
        if (c === 'S') this.start = { x: j, y: height };
        else if (c === 'X') this.field[key] = 'X';
        else if (c === 'O') this.bonuses.push({ x: j, y: height });
        else if (c === 'E') this.finish = { x: j, y: height };
      }
      height++;
      width = Math.max(width, ln.length);
    }

    if (!this.start) throw new Error('В поле не задан старт (S)');
    this.height = height;
    this.width = width;
  }
}

class Machine {
  constructor(code, field) {
    this.stack = [];
    this.code = code.block;
    this.ip = 0;
    this.totalSteps = 0;
    this.bonusScore = 0;

    this.field = field;
    this.x = field.start.x;
    this.y = field.start.y;
    this.dirX = field.startDir[0];
    this.dirY = field.startDir[1];
    this.bonuses = field.bonuses.map(b => ({ x: b.x, y: b.y }));

    this.isRunning = true;
    this.errorMessage = null;
  }

  step() {
    if (!this.isRunning) return;

    while (this.ip >= this.code.length) {
      if (this.stack.length === 0) { this.isRunning = false; return; }
      const frame = this.stack[this.stack.length - 1];
      if (frame.isCycle) {
        this.ip = 0;
        break;
      } else {
        this.stack.pop();
        this.code = frame.code;
        this.ip = frame.ip;
      }
    }

    const cmd = this.code[this.ip];
    if (cmd.cmd === 'шаг') {
      if (!this._cellAvailable(this.x + this.dirX, this.y + this.dirY)) {
        this._setError('Столкновение!');
      } else {
        this.x += this.dirX;
        this.y += this.dirY;
      }
      this.ip++;
    } else if (cmd.cmd === 'лево') {
      const ndx = this.dirY, ndy = -this.dirX;
      this.dirX = ndx; this.dirY = ndy;
      this.ip++;
    } else if (cmd.cmd === 'право') {
      const ndx = -this.dirY, ndy = this.dirX;
      this.dirX = ndx; this.dirY = ndy;
      this.ip++;
    } else if (cmd.cmd === 'повтор') {
      this.stack.push({ code: this.code, ip: this.ip + 1, isCycle: true });
      this.code = cmd.block;
      this.ip = 0;
    } else if (cmd.cmd === 'выход') {
      let found = false;
      while (this.stack.length > 0) {
        const top = this.stack.pop();
        if (top.isCycle) {
          this.code = top.code;
          this.ip = top.ip;
          found = true;
          break;
        }
      }
      if (!found) { this._setError('Команда "выход" без "повтора"'); return; }
    } else if (cmd.cmd === 'если') {
      const cond = this._checkCondition(cmd.args);
      if (cond === null) { this._setError(`Неизвестное условие "${cmd.args}"`); return; }
      if (cond) {
        this.stack.push({ code: this.code, ip: this.ip + 1, isCycle: false });
        this.code = cmd.block;
        this.ip = 0;
      } else {
        this.ip++;
      }
    } else {
      this._setError(`Неизвестная команда "${cmd.cmd}"`);
      return;
    }

    this.totalSteps++;

    const pos = { x: this.x, y: this.y };
    if (this.field.finish && pos.x === this.field.finish.x && pos.y === this.field.finish.y) {
      this.isRunning = false;
    }

    const bi = this.bonuses.findIndex(b => b.x === pos.x && b.y === pos.y);
    if (bi !== -1) {
      this.bonuses.splice(bi, 1);
      this.bonusScore++;
    }
  }

  _cellAvailable(x, y) {
    if (x < 0 || y < 0 || x >= this.field.width || y >= this.field.height) return false;
    return this.field.field[`${x},${y}`] !== 'X';
  }

  _checkCondition(condition) {
    const CONDITIONS = ['св', 'занято', 'св слева', 'св справа', 'занято слева', 'занято справа'];
    if (!CONDITIONS.includes(condition)) return null;
    let dx = this.dirX, dy = this.dirY;
    if (condition.includes('слева')) { const ndx = dy, ndy = -dx; dx = ndx; dy = ndy; }
    else if (condition.includes('справа')) { const ndx = -dy, ndy = dx; dx = ndx; dy = ndy; }
    const inverse = condition.includes('занято');
    const result = this._cellAvailable(this.x + dx, this.y + dy);
    return inverse ? !result : result;
  }

  _setError(msg) {
    this.isRunning = false;
    this.errorMessage = msg;
  }

  getLineIndex() {
    if (this.isRunning && this.code.length > 0 && this.ip < this.code.length) {
      return this.code[this.ip].codeLine;
    }
    return null;
  }

  debugStatus() {
    const basics = `Бонусов: ${this.bonusScore}\nPos: (${this.x + 1}, ${this.y + 1}), Dir: (${this.dirX}, ${this.dirY})`;
    let line;
    if (this.ip < this.code.length) line = this.code[this.ip].codeLine + 1;
    else if (this.code.length > 0) line = `Behind ${this.code[this.code.length - 1].codeLine + 1}`;
    else line = '-';

    if (this.isRunning) {
      return `${basics}, Line: ${line}\nSteps: ${this.totalSteps}, Stack: ${this.stack.length}\nIP: ${this.ip} / ${this.code.length}`;
    } else if (this.errorMessage) {
      return `Ошибка: ${this.errorMessage}\n${basics}, Steps: ${this.totalSteps}`;
    } else {
      return `Финиш!\n${basics}, Steps: ${this.totalSteps}`;
    }
  }
}

/* ============================================================
   Интерфейс
   ============================================================ */

const CELL = 50;
const MARGIN = 5;
const MARGIN_O = 10;
const TIME_STEP = 500;
const TIME_STEP_FAST = 100;
const STORAGE_CODE = 'robot_code_v1';
const STORAGE_FIELD = 'robot_field_v1';

const defaultCode = `# идем вперед до ближайшей стены. надеемся, что это не остров в лабиринте
повтор
  если занято
    выход
  шаг
`;

const defaultField = `D
....E....
X......XX
...XXX..X
...XO...O
.S.X....X
......XXX
.O.......
...X.....`;

const codeArea = document.getElementById('codeArea');
const codeLinesDiv = document.getElementById('codeLines');
const statusDiv = document.getElementById('status');
const canvas = document.getElementById('fieldCanvas');
const ctx = canvas.getContext('2d');
const counterSpan = document.getElementById('counter');

const btnStartStop = document.getElementById('btnStartStop');
const btnStep = document.getElementById('btnStep');
const btnReset = document.getElementById('btnReset');
const btnCopyField = document.getElementById('btnCopyField');
const btnPasteField = document.getElementById('btnPasteField');
const btnRotate = document.getElementById('btnRotate');
const chkFast = document.getElementById('chkFast');

let code = null;
let field = null;
let M = null;
let playbackOn = false;
let timerId = null;
let robotTrace = [];
let lastRobotPos = null;

/* ---------- Сохранение/загрузка ---------- */
function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_CODE, codeArea.value);
    localStorage.setItem(STORAGE_FIELD, fieldToText());
  } catch (e) { /* ignore */ }
}

function loadFromStorage() {
  let codeText = localStorage.getItem(STORAGE_CODE);
  let fieldText = localStorage.getItem(STORAGE_FIELD);
  if (!codeText) codeText = defaultCode;
  if (!fieldText) fieldText = defaultField;
  codeArea.value = codeText;
  return fieldText;
}

/* ---------- Поле → текст ---------- */
function fieldToText() {
  const lines = [];
  let dir = 'D';
  if (M) {
    if (M.dirX === -1) dir = 'L';
    else if (M.dirX === 1) dir = 'R';
    else if (M.dirY === -1) dir = 'U';
    else if (M.dirY === 1) dir = 'D';
  } else if (field) {
    if (field.startDir[0] === -1) dir = 'L';
    else if (field.startDir[0] === 1) dir = 'R';
    else if (field.startDir[1] === -1) dir = 'U';
    else if (field.startDir[1] === 1) dir = 'D';
  }
  lines.push(dir);

  const w = field ? field.width : 0;
  const h = field ? field.height : 0;
  const grid = [];
  for (let y = 0; y < h; y++) grid.push(new Array(w).fill('.'));

  if (field) {
    for (const key in field.field) {
      const parts = key.split(',');
      const x = Number(parts[0]), y = Number(parts[1]);
      grid[y][x] = 'X';
    }
    const activeBonuses = M ? M.bonuses : field.bonuses;
    for (const b of activeBonuses) grid[b.y][b.x] = 'O';
    if (field.finish) grid[field.finish.y][field.finish.x] = 'E';
    if (field.start) grid[field.start.y][field.start.x] = 'S';
  }
  for (let y = 0; y < h; y++) lines.push(grid[y].join(''));
  return lines.join('\n');
}

/* ---------- Текст → нормализованное поле ---------- */
function parseFieldText(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Слишком мало строк');
  const dirLine = lines[0].trim().toUpperCase();
  if (['L','R','U','D'].indexOf(dirLine) === -1) throw new Error('Неверное направление');

  const bodyLines = lines.slice(1).filter(l => l.trim() !== '');
  if (bodyLines.length === 0) throw new Error('Нет строк поля');
  const n = bodyLines.length;
  for (const l of bodyLines) {
    if (l.length !== n) throw new Error(`Строка должна быть длины ${n}`);
    for (const c of l) {
      if ('SEXO.'.indexOf(c) === -1) throw new Error(`Недопустимый символ "${c}"`);
    }
  }
  return dirLine + '\n' + bodyLines.join('\n');
}

/* ---------- Отрисовка ---------- */
function resizeCanvas() {
  const w = field.width * CELL;
  const h = field.height * CELL;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}

function cellRect(ix, iy, margin) {
  if (margin === undefined) margin = MARGIN;
  return {
    x: ix * CELL + margin,
    y: iy * CELL + margin,
    w: CELL - margin * 2,
    h: CELL - margin * 2
  };
}

function cellCenter(ix, iy) {
  return { x: ix * CELL + CELL / 2, y: iy * CELL + CELL / 2 };
}

function drawField() {
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < field.height; y++) {
    for (let x = 0; x < field.width; x++) {
      const r = cellRect(x, y);
      const isWall = field.field[x + ',' + y] === 'X';
      ctx.fillStyle = isWall ? '#ffffff' : '#c8ccd0';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (isWall) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        for (let i = -r.h; i < r.w; i += 8) {
          ctx.beginPath();
          ctx.moveTo(r.x + i, r.y);
          ctx.lineTo(r.x + i + r.h, r.y + r.h);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  if (field.finish) {
    const r = cellRect(field.finish.x, field.finish.y, MARGIN_O);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e74c3c';
    ctx.fill();
  }
  if (field.start) {
    const sr = cellRect(field.start.x, field.start.y, MARGIN_O);
    ctx.beginPath();
    ctx.ellipse(sr.x + sr.w / 2, sr.y + sr.h / 2, sr.w / 2, sr.h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#555';
    ctx.fill();
  }

  drawBonuses();
  drawTrace();
  drawRobot();
}

function drawBonuses() {
  if (!M) return;
  for (const b of M.bonuses) {
    const r = cellRect(b.x, b.y, MARGIN_O);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#f39c12';
    ctx.fill();
  }
}

function drawTrace() {
  ctx.strokeStyle = 'rgba(46, 204, 113, 0.55)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const seg of robotTrace) {
    const c1 = cellCenter(seg.x1, seg.y1);
    const c2 = cellCenter(seg.x2, seg.y2);
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.stroke();
    const ang = Math.atan2(c2.y - c1.y, c2.x - c1.x);
    const len = 8;
    ctx.beginPath();
    ctx.moveTo(c2.x, c2.y);
    ctx.lineTo(c2.x - len * Math.cos(ang - 0.4), c2.y - len * Math.sin(ang - 0.4));
    ctx.moveTo(c2.x, c2.y);
    ctx.lineTo(c2.x - len * Math.cos(ang + 0.4), c2.y - len * Math.sin(ang + 0.4));
    ctx.stroke();
  }
}

function drawRobot() {
  if (!M) return;
  const c = cellCenter(M.x, M.y);
  const s = CELL / 2 - MARGIN_O;
  ctx.fillStyle = '#27ae60';
  ctx.fillRect(c.x - s, c.y - s, s * 2, s * 2);
  ctx.strokeStyle = '#1e8449';
  ctx.lineWidth = 2;
  ctx.strokeRect(c.x - s, c.y - s, s * 2, s * 2);

  ctx.beginPath();
  ctx.moveTo(c.x + M.dirX * s, c.y + M.dirY * s);
  ctx.lineTo(c.x + M.dirX * s - M.dirY * s * 0.45 - M.dirX * s * 0.35,
             c.y + M.dirY * s + M.dirX * s * 0.45 - M.dirY * s * 0.35);
  ctx.lineTo(c.x + M.dirX * s + M.dirY * s * 0.45 - M.dirX * s * 0.35,
             c.y + M.dirY * s - M.dirX * s * 0.45 - M.dirY * s * 0.35);
  ctx.closePath();
  ctx.fillStyle = '#145a32';
  ctx.fill();
}

/* ---------- Отрисовка кода ---------- */
let codeLineEls = {};
let hilitedLine = null;

function renderCodeLines() {
  codeLinesDiv.innerHTML = '';
  codeLineEls = {};
  if (!code) return;
  const flat = [];
  function walk(block, indent) {
    for (const c of block) {
      flat.push({ c: c, indent: indent });
      if (c.block) walk(c.block, indent + 2);
    }
  }
  walk(code.block, 0);
  flat.sort((a, b) => a.c.codeLine - b.c.codeLine);
  for (const item of flat) {
    const c = item.c;
    const indent = item.indent;
    const el = document.createElement('div');
    el.className = 'code-line';
    el.dataset.line = c.codeLine;
    const num = String(c.codeLine + 1).padStart(2, '0');
    el.textContent = num + ': ' + ' '.repeat(indent) + c.cmd + (c.args ? ':' : '') + ' ' + c.args;
    codeLinesDiv.appendChild(el);
    codeLineEls[c.codeLine] = el;
  }
}

function updateHighlight() {
  const lineIdx = M ? M.getLineIndex() : null;
  if (lineIdx === hilitedLine) return;
  if (hilitedLine !== null && codeLineEls[hilitedLine]) {
    codeLineEls[hilitedLine].classList.remove('active');
  }
  if (lineIdx !== null && codeLineEls[lineIdx]) {
    codeLineEls[lineIdx].classList.add('active');
  }
  hilitedLine = lineIdx;
}

/* ---------- Статус ---------- */
function updateStatus() {
  statusDiv.classList.remove('error', 'finish');
  if (!M) { statusDiv.textContent = 'Готов'; return; }
  statusDiv.textContent = M.debugStatus();
  if (M.errorMessage) statusDiv.classList.add('error');
  else if (!M.isRunning && !M.errorMessage) statusDiv.classList.add('finish');
  counterSpan.textContent = M.bonusScore;
}

/* ---------- След ---------- */
function updateTrace() {
  if (!M) return;
  const pos = { x: M.x, y: M.y, dx: M.dirX, dy: M.dirY };
  if (lastRobotPos) {
    if (lastRobotPos.x !== pos.x || lastRobotPos.y !== pos.y ||
        lastRobotPos.dx !== pos.dx || lastRobotPos.dy !== pos.dy) {
      robotTrace.push({
        x1: lastRobotPos.x, y1: lastRobotPos.y,
        x2: pos.x, y2: pos.y
      });
    }
  }
  lastRobotPos = pos;
}

/* ---------- Инициализация ВМ ---------- */
function compileCode() {
  code = new Code(codeArea.value);
  renderCodeLines();
  hilitedLine = null;
}

function initMachine() {
  if (!code) compileCode();
  M = new Machine(code, field);
  robotTrace = [];
  lastRobotPos = { x: M.x, y: M.y, dx: M.dirX, dy: M.dirY };
  drawField();
  updateStatus();
  updateHighlight();
}

function executeOneStep() {
  if (!M || !M.isRunning) return false;
  M.step();
  updateTrace();
  drawField();
  updateStatus();
  updateHighlight();
  return true;
}

/* ---------- Цикл ---------- */
function tick() {
  if (playbackOn && M && M.isRunning) {
    executeOneStep();
    if (!M.isRunning) {
      playbackOn = false;
      btnStartStop.textContent = '▶ Пуск';
      btnStartStop.classList.remove('active');
    }
  }
  const delay = chkFast.checked ? TIME_STEP_FAST : TIME_STEP;
  timerId = setTimeout(tick, delay);
}

/* ---------- Кнопки ---------- */
btnStartStop.addEventListener('click', function () {
  if (!M) initMachine();
  playbackOn = !playbackOn;
  btnStartStop.textContent = playbackOn ? '⏸ Пауза' : '▶ Пуск';
  btnStartStop.classList.toggle('active', playbackOn);
});

btnStep.addEventListener('click', function () {
  if (!M) initMachine();
  playbackOn = false;
  btnStartStop.textContent = '▶ Пуск';
  btnStartStop.classList.remove('active');
  executeOneStep();
});

function doReset() {
  playbackOn = false;
  btnStartStop.textContent = '▶ Пуск';
  btnStartStop.classList.remove('active');
  try {
    compileCode();
  } catch (e) {
    statusDiv.textContent = 'Ошибка в программе: ' + e.message;
    statusDiv.classList.add('error');
    return;
  }
  initMachine();
}

btnReset.addEventListener('click', doReset);

btnRotate.addEventListener('click', function () {
  if (!M) return;
  const ndx = -M.dirY, ndy = M.dirX;
  M.dirX = ndx; M.dirY = ndy;
  lastRobotPos = { x: M.x, y: M.y, dx: M.dirX, dy: M.dirY };
  drawField();
  updateStatus();
  saveToStorage();
});

/* ---------- Клик по роботу — поворот ---------- */
canvas.addEventListener('click', function (ev) {
  if (!M) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const rx = M.x * CELL + CELL / 2;
  const ry = M.y * CELL + CELL / 2;
  const s = CELL / 2;
  if (Math.abs(mx - rx) <= s && Math.abs(my - ry) <= s) {
    const ndx = -M.dirY, ndy = M.dirX;
    M.dirX = ndx; M.dirY = ndy;
    lastRobotPos = { x: M.x, y: M.y, dx: M.dirX, dy: M.dirY };
    drawField();
    updateStatus();
    saveToStorage();
  }
});

/* ---------- ПКМ по клетке — стена вкл/выкл ---------- */
canvas.addEventListener('contextmenu', function (ev) {
  ev.preventDefault();
  if (!M) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const cx = Math.floor(mx / CELL);
  const cy = Math.floor(my / CELL);
  if (cx < 0 || cy < 0 || cx >= field.width || cy >= field.height) return;

  const key = cx + ',' + cy;
  if (field.field[key] === 'X') {
    delete field.field[key];
  } else {
    field.field[key] = 'X';
    field.bonuses = field.bonuses.filter(b => !(b.x === cx && b.y === cy));
    if (field.start && field.start.x === cx && field.start.y === cy) field.start = null;
    if (field.finish && field.finish.x === cx && field.finish.y === cy) field.finish = null;
  }
  if (field.start) {
    M = new Machine(code, field);
    robotTrace = [];
    lastRobotPos = { x: M.x, y: M.y, dx: M.dirX, dy: M.dirY };
  }
  drawField();
  updateStatus();
  saveToStorage();
});

/* ---------- Копирование/вставка поля ---------- */
btnCopyField.addEventListener('click', function () {
  const text = fieldToText();
  const done = function () {
    statusDiv.textContent = 'Поле скопировано в буфер обмена';
    statusDiv.classList.remove('error', 'finish');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () {
      fallbackCopy(text); done();
    });
  } else {
    fallbackCopy(text); done();
  }
});

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
}

btnPasteField.addEventListener('click', function () {
  const apply = function (text) {
    try {
      const normalized = parseFieldText(text);
      field = new Field(normalized);
      compileCode();
      initMachine();
      saveToStorage();
      statusDiv.textContent = 'Поле вставлено';
      statusDiv.classList.remove('error', 'finish');
    } catch (e) {
      statusDiv.textContent = 'Ошибка вставки: ' + e.message;
      statusDiv.classList.add('error');
    }
  };
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(apply).catch(function (e) {
      statusDiv.textContent = 'Не удалось прочитать буфер: ' + e.message;
      statusDiv.classList.add('error');
    });
  } else {
    statusDiv.textContent = 'Буфер обмена недоступен в этом браузере';
    statusDiv.classList.add('error');
  }
});

/* ---------- Автосохранение ---------- */
let saveTimeout = null;
function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveToStorage, 400);
}
codeArea.addEventListener('input', scheduleSave);

/* ---------- Инициализация ---------- */
function init() {
  const fieldText = loadFromStorage();
  try {
    compileCode();
  } catch (e) {
    statusDiv.textContent = 'Ошибка в программе: ' + e.message;
    statusDiv.classList.add('error');
    code = new Code('');
    renderCodeLines();
  }
  try {
    field = new Field(fieldText);
  } catch (e) {
    statusDiv.textContent = 'Ошибка поля: ' + e.message;
    statusDiv.classList.add('error');
    field = new Field(defaultField);
  }
  try {
    initMachine();
  } catch (e) {
    statusDiv.textContent = 'Ошибка инициализации: ' + e.message;
    statusDiv.classList.add('error');
  }
  tick();
}

init();

window.addEventListener('beforeunload', saveToStorage);

})();