/* Coop Knockout — a chicken boxing game. Plain JS + Canvas, no dependencies. */
(() => {
'use strict';

// ---------------------------------------------------------------- setup
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const WW = 960;      // world (ring) width
const H = 540;
let W = 960;         // view width: 960 normally, narrower on portrait phones (camera follows the action)
let compact = false; // true on narrow portrait screens
let backing = 1;     // canvas pixel density
const GROUND = 452;              // y of the chickens' feet
const RING_L = 140, RING_R = 820; // walkable ring bounds
const MIN_SEP = 78;              // fighters can't overlap closer than this
const ROUND_TIME = 60;
const WINS_NEEDED = 2;

const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const touchEl = document.getElementById('touch');

function resize() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const portrait = vh > vw * 1.05;
  compact = portrait && vw < 1000;
  W = compact ? 600 : 960;
  document.body.classList.toggle('portrait', isTouch && portrait);
  document.body.classList.toggle('landscape', isTouch && !portrait);
  let cw, ch;
  if (compact) {
    cw = vw; ch = cw * H / W;
    const maxH = vh * (isTouch ? 0.6 : 1);
    if (ch > maxH) { ch = maxH; cw = ch * W / H; }
  } else {
    const side = isTouch ? Math.min(92, vw * 0.11) : 0; // gutters for touch buttons
    const sc = Math.min((vw - 2 * side) / W, vh / H);
    cw = W * sc; ch = H * sc;
  }
  canvas.style.width = Math.floor(cw) + 'px';
  canvas.style.height = Math.floor(ch) + 'px';
  backing = clamp(cw * (window.devicePixelRatio || 1) / W, 1, 2);
  canvas.width = Math.round(W * backing);
  canvas.height = Math.round(H * backing);
  layoutTouch();
}
function layoutTouch() {
  touchEl.style.top = document.body.classList.contains('portrait') ? Math.floor(canvas.getBoundingClientRect().bottom) + 'px' : '';
}
let wasPlaying = null;
function syncPlaying() {
  const playing = ['entrance', 'intro', 'fight', 'knockdown', 'roundEnd', 'paused', 'matchEnd'].includes(game.state);
  if (playing === wasPlaying) return;
  wasPlaying = playing;
  document.body.classList.toggle('playing', playing);
  layoutTouch();
  if (!playing) { keys.clear(); touchEl.querySelectorAll('.on').forEach(b => b.classList.remove('on')); }
}
const fz = n => (compact ? Math.round(n * 0.8) : n); // font size helper
const hitRect = (r, p) => !!p && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
const twoButtons = y => { const bw = Math.min(200, W / 2 - 40); return [{ x: W / 2 - bw - 10, y, w: bw, h: 50 }, { x: W / 2 + 10, y, w: bw, h: 50 }]; };
function drawButton(r, label, hot) {
  roundRect(r.x, r.y, r.w, r.h, 12, hot ? '#b3261e' : '#000b', hot ? '#ffe08a' : '#ffffff60', 3);
  text(label, r.x + r.w / 2, r.y + r.h / 2 + 1, 20, '#fff', 'center', null, 800);
}

const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - (1 - t) * (1 - t);

// ---------------------------------------------------------------- input
const keys = new Set();
const pressed = new Set();
const GAME_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];

window.addEventListener('keydown', e => {
  Sound.init();
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// touch buttons act as virtual keys (mapped to Player 1)
if (isTouch) document.body.classList.add('touch');
document.querySelectorAll('#touch button').forEach(btn => {
  const code = btn.dataset.key;
  const down = e => { e.preventDefault(); Sound.init(); if (!keys.has(code)) pressed.add(code); keys.add(code); btn.classList.add('on'); };
  const up = e => { e.preventDefault(); keys.delete(code); btn.classList.remove('on'); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
});

let clickPos = null;
canvas.addEventListener('pointerdown', e => {
  Sound.init();
  const r = canvas.getBoundingClientRect();
  clickPos = { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
});

const P1_KEYS = { left: ['KeyA'], right: ['KeyD'], block: ['KeyS'], dodge: ['KeyW'], jab: ['KeyF'], hook: ['KeyG'], special: ['KeyH'] };
const P2_KEYS = { left: ['ArrowLeft'], right: ['ArrowRight'], block: ['ArrowDown'], dodge: ['ArrowUp'], jab: ['KeyJ'], hook: ['KeyK'], special: ['KeyL'] };
const SOLO_KEYS = {};
for (const k in P1_KEYS) SOLO_KEYS[k] = [...P1_KEYS[k], ...P2_KEYS[k]];
SOLO_KEYS.dodge.push('Space');

const anyOf = (set, list) => list.some(k => set.has(k));
function readIntent(map) {
  return {
    left: anyOf(keys, map.left), right: anyOf(keys, map.right), block: anyOf(keys, map.block),
    dodgeP: anyOf(pressed, map.dodge), jabP: anyOf(pressed, map.jab),
    hookP: anyOf(pressed, map.hook), specialP: anyOf(pressed, map.special),
    mash: anyOf(pressed, [...map.jab, ...map.hook, ...map.special]),
  };
}
const emptyIntent = () => ({ left: false, right: false, block: false, dodgeP: false, jabP: false, hookP: false, specialP: false, mash: false });

// ---------------------------------------------------------------- sound
const Sound = {
  ctx: null, muted: false,
  init() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ } }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'square', vol = 0.15, slide = 0, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, vol = 0.3, freq = 1500, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(this.ctx.destination); src.start(t);
  },
  hit(big) { this.noise(big ? 0.18 : 0.1, big ? 0.9 : 0.5, big ? 700 : 1400); this.tone(big ? 110 : 160, 0.15, 'sine', 0.5, -70); },
  block() { this.tone(900, 0.05, 'square', 0.08); this.noise(0.05, 0.25, 3500); },
  whoosh() { this.noise(0.12, 0.15, 2600); },
  cluck(pitch = 1) { this.tone(700 * pitch, 0.07, 'square', 0.08, -300 * pitch); this.tone(560 * pitch, 0.09, 'square', 0.07, -250 * pitch, 0.09); },
  bell(n = 1) { for (let i = 0; i < n; i++) [1, 2.76, 5.4].forEach((m, j) => this.tone(620 * m, 1.4, 'sine', 0.18 / (j + 1), 0, i * 0.35)); },
  thud() { this.tone(70, 0.4, 'sine', 0.6, -40); this.noise(0.25, 0.5, 300); },
  count() { this.tone(330, 0.12, 'triangle', 0.25); },
  crowd(vol = 0.2) { this.noise(1.2, vol, 900); this.noise(1.0, vol * 0.6, 1800, 0.1); },
  fanfare(m = 1) { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f * m, i > 3 ? 0.4 : 0.14, 'square', 0.07, 0, i * 0.13)); },
  crow() { this.tone(500, 0.15, 'sawtooth', 0.1, 300); this.tone(800, 0.5, 'sawtooth', 0.1, -350, 0.15); },
  select() { this.tone(660, 0.06, 'square', 0.08); },
  moo() { this.tone(150, 0.7, 'sawtooth', 0.12, -45); this.tone(152, 0.7, 'square', 0.04, -50); },
  oink() { this.tone(420, 0.08, 'sawtooth', 0.12, -160); this.tone(390, 0.1, 'sawtooth', 0.1, -180, 0.11); },
  boing() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), lfo = this.ctx.createOscillator(), lg = this.ctx.createGain(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(420, t + 0.7);
    lfo.frequency.value = 16; lg.gain.setValueAtTime(90, t); lg.gain.exponentialRampToValueAtTime(1, t + 0.8);
    lfo.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    o.connect(g).connect(this.ctx.destination); o.start(t); lfo.start(t); o.stop(t + 0.9); lfo.stop(t + 0.9);
  },
  voice(look, pitch = 1) {
    if (look.type === 'cow') this.moo();
    else if (look.type === 'pig') this.oink();
    else this.cluck(look.voice * pitch);
  },
  call(look) {
    if (look.type === 'cow') this.moo();
    else if (look.type === 'pig') { this.oink(); setTimeout(() => this.oink(), 220); }
    else this.crow();
  },
};

// ---------------------------------------------------------------- fx
const particles = [];
const popups = [];
let shake = 0, hitstop = 0, flashScreen = 0;

function feathers(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    particles.push({
      x, y, vx: rand(-260, 260), vy: rand(-320, -60), rot: rand(6.28), vr: rand(-8, 8),
      life: rand(1.2, 2.2), max: 2.2, color: Math.random() < 0.3 ? '#fff' : color, size: rand(5, 10), kind: 'feather',
    });
  }
}
function sparks(x, y, n, color = '#ffe066') {
  for (let i = 0; i < n; i++) {
    const a = rand(6.28), s = rand(120, 380);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.25, max: 0.25, color, size: rand(2, 4), kind: 'spark' });
  }
}
function popup(text, x, y, color = '#fff', size = 30) {
  popups.push({ text, x, y, t: 0, color, size });
}
function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    if (p.kind === 'feather') {
      p.vx *= 1 - 2.5 * dt; p.vy = Math.min(p.vy + 500 * dt, 60);
      p.x += (p.vx + Math.sin(p.life * 6) * 40) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.y > GROUND + 10) { p.y = GROUND + 10; p.vy = 0; p.vx = 0; p.vr = 0; }
    } else { p.x += p.vx * dt; p.y += p.vy * dt; }
  }
  for (let i = popups.length - 1; i >= 0; i--) {
    popups[i].t += dt;
    if (popups[i].t > 0.9) popups.splice(i, 1);
  }
  shake = Math.max(0, shake - dt * 30);
  flashScreen = Math.max(0, flashScreen - dt * 3);
}

// ---------------------------------------------------------------- fighters
const ATK = {
  jab:     { start: 0.07, active: 0.08, rec: 0.15, dmg: 5,  range: 112, stam: 7,  kb: 70,  stun: 0.2,  meter: 7,  name: 'jab' },
  hook:    { start: 0.2,  active: 0.1,  rec: 0.32, dmg: 12, range: 120, stam: 17, kb: 190, stun: 0.38, meter: 12, name: 'hook' },
  special: { start: 0.32, active: 0.28, rec: 0.42, dmg: 22, range: 100, stam: 0,  kb: 380, stun: 0.65, meter: 0,  name: 'special', dash: 560 },
};

// People in mascot costumes. Knock them out and the costume head pops up on its spring.
const ROSTER = [
  { name: 'NUGGET', type: 'chicken', suit: 'Chicken suit', body: '#fbf6ea', shade: '#e4d8bf', shorts: '#c62828', trim: '#ffd54f', glove: '#e53935',
    tail: ['#fff', '#ede3cc', '#d9caa6'], comb: '#e02a2a', voice: 1.1, special: 'NUGGET NUKE',
    person: { name: 'GARY', bio: 'Gary, 44, accounts payable', skin: '#f2c79b', hair: '#5a3a22', style: 'bald' } },
  { name: 'BIG RED', type: 'rooster', suit: 'Rooster suit', body: '#b5562a', shade: '#8a3d1c', shorts: '#1e4fb8', trim: '#fff', glove: '#1e63d6',
    tail: ['#1f5f3a', '#173a2b', '#2b7a4b'], comb: '#d81b1b', voice: 0.8, special: 'ROOSTER ROCKET',
    person: { name: 'DENISE', bio: 'Denise, 31, yoga instructor', skin: '#8d5a3b', hair: '#1b1b1b', style: 'puff' } },
  { name: 'BESSIE BRUISER', type: 'cow', suit: 'Cow suit', body: '#f7f4ee', shade: '#d9d3c8', shorts: '#2e7d32', trim: '#ffeb3b', glove: '#43a047',
    comb: '#f4b6c2', voice: 1, special: 'UDDER DESTRUCTION',
    person: { name: 'KEVIN', bio: 'Kevin, 27, substitute teacher', skin: '#efc19a', hair: '#e0b04a', style: 'short' } },
  { name: 'HAMHOCK', type: 'pig', suit: 'Pig suit', body: '#f6aebf', shade: '#e48aa0', shorts: '#6a1b9a', trim: '#f8bbd0', glove: '#8e24aa',
    comb: '#f29bb0', voice: 1, special: 'HAM HAMMER',
    person: { name: 'MARGARET', bio: 'Margaret, 71, retired', skin: '#d9a07a', hair: '#bdbdbd', style: 'bun' } },
];

class Fighter {
  constructor(look, side) {
    this.look = look; this.side = side; this.phase = rand(10);
    this.wins = 0;
    this.resetRound();
  }
  resetRound() {
    this.x = this.side === 0 ? RING_L + 130 : RING_R - 130;
    this.vx = 0; this.facing = this.side === 0 ? 1 : -1;
    this.hp = 100; this.dispHp = 100; this.stamina = 100; this.special = 0;
    this.knockdowns = 0;
    this.toIdle();
    this.flash = 0; this.buffer = null; this.bufT = 0; this.walkT = 0;
    this.downT = 0; this.getupProgress = 0; this.dizzy = 0;
    this.popY = 0; this.popV = 0;
    this.taunt = false; this.taunted = false; this.raised = false; this.raiseK = 0; this.dejected = false;
  }
  // springy costume head: popY = how far the head has popped up off the suit
  updatePop(dt, target) {
    const k = 240, c = 7;
    this.popV += (k * (target - this.popY) - c * this.popV) * dt;
    this.popY += this.popV * dt;
    if (this.popY < 0) { this.popY = 0; this.popV = Math.abs(this.popV) * 0.35; }
  }
  toIdle() { this.state = 'idle'; this.t = 0; this.atk = null; this.atkPhase = null; }
  invuln() { return this.state === 'dodge' && this.t < 0.3; }
  busy() { return !(this.state === 'idle' || this.state === 'walk' || this.state === 'block'); }

  startAttack(type) {
    const a = ATK[type];
    if (type === 'special') {
      if (this.special < 100) return;
      this.special = 0;
      popup(this.look.special + '!', this.x, GROUND - 210, '#ffcc00', 26);
      Sound.call(this.look);
    } else {
      if (this.stamina < a.stam * 0.6) { popup('TIRED', this.x, GROUND - 170, '#9ecbff', 20); return; }
      this.stamina = Math.max(0, this.stamina - a.stam);
    }
    this.slow = this.stamina < 20 && type !== 'special' ? 1.4 : 1;
    this.state = 'attack'; this.atk = type; this.t = 0; this.hitDone = false; this.atkPhase = 'start'; this.dodgePopped = false;
    Sound.whoosh();
  }

  startDodge() {
    if (this.stamina < 10) { popup('TIRED', this.x, GROUND - 170, '#9ecbff', 20); return; }
    this.stamina -= 12;
    this.state = 'dodge'; this.t = 0; this.vx = -this.facing * 520;
  }

  update(dt, intent, opp, canAct) {
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.updatePop(dt, this.state === 'down' || this.state === 'ko' ? 105 : 0);
    this.dispHp = lerp(this.dispHp, this.hp, 1 - Math.pow(0.02, dt));

    if (this.state === 'down' || this.state === 'ko') {
      this.vx *= Math.pow(0.02, dt);
      this.x = clamp(this.x + this.vx * dt, RING_L, RING_R);
      return;
    }

    if (!this.busy()) this.facing = opp.x > this.x ? 1 : -1;

    // input buffering so presses during recovery aren't lost
    if (canAct) {
      if (intent.specialP) { this.buffer = 'special'; this.bufT = 0.18; }
      else if (intent.hookP) { this.buffer = 'hook'; this.bufT = 0.18; }
      else if (intent.jabP) { this.buffer = 'jab'; this.bufT = 0.18; }
      else if (intent.dodgeP) { this.buffer = 'dodge'; this.bufT = 0.18; }
    }
    this.bufT -= dt;
    if (this.bufT <= 0) this.buffer = null;

    switch (this.state) {
      case 'idle': case 'walk': case 'block': {
        if (canAct && this.buffer) {
          const b = this.buffer; this.buffer = null;
          if (b === 'dodge') this.startDodge(); else this.startAttack(b);
          if (this.busy()) break;
        }
        if (canAct && intent.block) {
          if (this.state !== 'block') { this.state = 'block'; this.t = 0; }
          this.vx *= Math.pow(0.001, dt);
          this.stamina = Math.min(100, this.stamina + 7 * dt);
          break;
        }
        let dir = 0;
        if (canAct) { if (intent.left) dir -= 1; if (intent.right) dir += 1; }
        const speed = this.stamina < 20 ? 150 : 210;
        if (dir) {
          this.vx = lerp(this.vx, dir * speed, 1 - Math.pow(0.0001, dt));
          if (this.state !== 'walk') { this.state = 'walk'; this.t = 0; }
          this.walkT += dt * (dir === this.facing ? 1 : -1);
        } else {
          this.vx *= Math.pow(0.0005, dt);
          if (this.state !== 'idle') { this.state = 'idle'; this.t = 0; }
        }
        this.stamina = Math.min(100, this.stamina + 20 * dt);
        break;
      }
      case 'attack': {
        const a = ATK[this.atk];
        const s = a.start * this.slow, ac = a.active, r = a.rec * this.slow;
        this.vx *= Math.pow(0.002, dt);
        if (this.t < s) {
          this.atkPhase = 'start';
          if (this.atk === 'special') this.vx = -this.facing * 40;
        } else if (this.t < s + ac) {
          this.atkPhase = 'active';
          if (this.atk === 'special') {
            this.vx = this.facing * a.dash;
            if (!this.hitDone) this.hitDone = tryHit(this, opp, a);
          } else if (!this.hitDone) {
            this.hitDone = true;
            tryHit(this, opp, a);
          }
        } else if (this.t < s + ac + r) {
          this.atkPhase = 'rec';
        } else this.toIdle();
        break;
      }
      case 'hit':
        this.vx *= Math.pow(0.01, dt);
        if (this.t > this.stun) this.toIdle();
        break;
      case 'dodge':
        this.vx *= Math.pow(0.004, dt);
        if (this.t > 0.38) this.toIdle();
        break;
    }

    this.x = clamp(this.x + this.vx * dt, RING_L, RING_R);
  }

  takeHit(dmg, kb, stun, dir) {
    this.hp = Math.max(0, this.hp - dmg);
    this.state = 'hit'; this.t = 0; this.stun = stun; this.atk = null; this.atkPhase = null;
    this.vx = dir * kb; this.flash = 0.12; this.buffer = null;
  }
}

function tryHit(att, def, a) {
  const dx = (def.x - att.x) * att.facing;
  if (dx < 0 || dx > a.range || def.state === 'down' || def.state === 'ko') return false;
  if (def.invuln()) {
    if (!att.dodgePopped) { att.dodgePopped = true; popup('DODGE!', def.x, GROUND - 170, '#9cf59c', 22); }
    return a === ATK.special ? false : true;
  }
  const hx = att.x + att.facing * (a.range - 30), hy = GROUND - 125;
  const blocked = def.state === 'block' && def.facing === -att.facing;
  if (blocked) {
    let chip = a === ATK.special ? a.dmg * 0.4 : a.dmg * 0.12;
    def.hp = Math.max(1, def.hp - chip);
    def.stamina -= a.dmg * (a === ATK.special ? 3 : 1.6);
    def.vx = att.facing * a.kb * 0.5;
    att.special = Math.min(100, att.special + a.meter * 0.3);
    sparks(hx, hy, 8, '#cfe8ff');
    Sound.block();
    if (def.stamina <= 0) {
      def.stamina = 0;
      def.takeHit(0, a.kb * 0.6, 0.75, att.facing);
      popup('GUARD BREAK!', def.x, GROUND - 180, '#ff8a65', 26);
      Sound.hit(true);
      shake = 8;
    }
    return true;
  }
  const counter = def.state === 'attack' && def.atkPhase === 'start';
  let dmg = a.dmg * (counter ? 1.35 : 1) * (att.stamina < 20 && a !== ATK.special ? 0.75 : 1);
  dmg = Math.round(dmg * rand(0.9, 1.1));
  def.takeHit(dmg, a.kb, a.stun, att.facing);
  att.special = Math.min(100, att.special + a.meter);
  def.special = Math.min(100, def.special + dmg * 0.5);
  const big = a !== ATK.jab;
  feathers(hx, hy, big ? 14 : 5, def.look.body);
  sparks(hx, hy, big ? 14 : 6);
  Sound.hit(big);
  if (Math.random() < 0.4) Sound.voice(def.look);
  def.popV += big ? 230 : 90; // head wobbles on its spring
  shake = big ? 10 : 4;
  hitstop = big ? 0.08 : 0.03;
  if (counter) popup('COUNTER!', def.x, GROUND - 200, '#ff5252', 26);
  popup('-' + dmg, def.x + rand(-20, 20), GROUND - 150, big ? '#ffd54f' : '#fff', big ? 30 : 22);
  game.crowdHype = Math.min(1, game.crowdHype + (big ? 0.35 : 0.1));
  if (def.hp <= 0) game.knockdown(def, att);
  return true;
}

// ---------------------------------------------------------------- AI
const DIFF = {
  EASY:   { think: 0.5,  react: 0.15, block: 0.25, aggr: 0.35, getup: 0.45 },
  NORMAL: { think: 0.3,  react: 0.4,  block: 0.4,  aggr: 0.55, getup: 0.7 },
  HARD:   { think: 0.17, react: 0.68, block: 0.55, aggr: 0.72, getup: 0.9 },
};

class AI {
  constructor(level) { this.d = DIFF[level]; this.timer = 0.6; this.move = 0; this.holdBlock = 0; this.reacted = false; this.mashT = 0; }
  intent(dt, me, opp, state) {
    const it = emptyIntent();
    if (state === 'knockdown') {
      // mash to get up (difficulty decides how fast)
      this.mashT -= dt;
      if (this.mashT <= 0) { it.mash = true; this.mashT = rand(0.08, 0.2) / this.d.getup; }
      return it;
    }
    const d = this.d;
    const dx = opp.x - me.x, dist = Math.abs(dx), toward = Math.sign(dx);

    // react to incoming attacks
    if (opp.state === 'attack' && opp.atkPhase === 'start') {
      if (!this.reacted && dist < ATK[opp.atk].range + 40) {
        this.reacted = true;
        if (Math.random() < d.react) {
          if (Math.random() < 0.7 && me.stamina > 18) this.holdBlock = 0.35 + rand(0.2);
          else it.dodgeP = true;
        }
      }
    } else this.reacted = false;

    if (this.holdBlock > 0) {
      this.holdBlock -= dt; it.block = true;
      // punish whiffs / blocked recoveries
      if (opp.state === 'attack' && opp.atkPhase === 'rec' && dist < 120 && Math.random() < d.aggr * 0.15) { this.holdBlock = 0; it.block = false; it.jabP = true; }
      return it;
    }

    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = d.think * rand(0.6, 1.4);
      this.move = 0;
      const r = Math.random();
      if (me.special >= 100 && dist < 230 && r < 0.6) it.specialP = true;
      else if (dist > 125) this.move = Math.random() < 0.85 ? toward : 0;
      else if (me.stamina < 25 && r < 0.6) this.move = -toward;
      else if (opp.state === 'hit' && r < 0.8) it.jabP = true;
      else if (r < d.aggr) { if (Math.random() < 0.6) it.jabP = true; else it.hookP = true; }
      else if (r < d.aggr + d.block * (1 - d.aggr)) this.holdBlock = rand(0.25, 0.6);
      else this.move = Math.random() < 0.5 ? -toward : toward;
    }
    if (this.move < 0) it.left = true; else if (this.move > 0) it.right = true;
    return it;
  }
}

// ---------------------------------------------------------------- game state
const game = {
  state: 'title', t: 0, sel: { p1: 0, p2: 1 }, mode: 1, level: 'NORMAL', menuIndex: 0,
  fighters: [], ai: null, round: 1, timer: ROUND_TIME, crowdHype: 0,
  msg: '', subMsg: '', downed: null, count: 0, countT: 0, result: '',

  start(mode) {
    this.mode = mode;
    this.fighters = [new Fighter(ROSTER[this.sel.p1], 0), new Fighter(ROSTER[this.sel.p2], 1)];
    this.ai = mode === 1 ? new AI(this.level) : null;
    this.round = 1;
    particles.length = 0; popups.length = 0;
    this.startRound();
  },
  startRound() {
    this.fighters.forEach(f => f.resetRound());
    this.timer = ROUND_TIME;
    this.camFocus = null;
    if (this.round === 1) { beginEntrances(); return; }
    refLeave();
    this.state = 'intro'; this.t = 0;
    Sound.bell(1);
  },
  knockdown(f, by) {
    f.knockdowns++;
    f.state = 'down'; f.t = 0; f.vx = by.facing * 200; f.getupProgress = 0; f.popV = 900;
    by.toIdle(); by.buffer = null;
    this.downed = f; this.by = by;
    this.count = 0; this.countT = 0;
    this.state = 'knockdown'; this.t = 0;
    hitstop = 0.25; shake = 18; flashScreen = 1;
    feathers(f.x, GROUND - 90, 30, f.look.body);
    Sound.thud(); Sound.boing(); Sound.crowd(0.35);
    popup('DOWN!', f.x, GROUND - 250, '#ff5252', 40);
    setTimeout(() => popup(`IT'S JUST ${f.look.person.name}!`, f.x, GROUND - 210, '#fff', 26), 500);
    this.crowdHype = 1;
    // getting up gets harder each time
    this.need = 10 + 8 * f.knockdowns;
    ref.speed = 340;
    refGoTo(clamp(f.x + (f.x < WW / 2 ? 1 : -1) * 80, RING_L - 20, RING_R + 20), 'count', f.x);
  },
  endRound(winner, how) {
    this.state = 'roundEnd'; this.t = 0;
    const [a, b] = this.fighters;
    if (winner) winner.wins++; else { a.wins++; b.wins++; }
    this.msg = how;
    this.subMsg = winner ? `${winner.look.name} TAKES ROUND ${this.round}` : 'DRAW ROUND';
    Sound.bell(3); Sound.crowd(0.3);
  },
  playerLabel(f) {
    if (this.mode === 1) return f.side === 0 ? 'YOU' : 'CPU ' + this.level;
    return f.side === 0 ? 'P1' : 'P2';
  },
};

const MENU = [
  { label: () => '1 PLAYER  vs CPU', act: () => openSelect(1) },
  { label: () => (isTouch ? '2 PLAYERS  (needs keyboard)' : '2 PLAYERS  (same keyboard)'), act: () => openSelect(2) },
  { label: () => `DIFFICULTY:  ◀ ${game.level} ▶`, act: dir => cycleLevel(dir || 1), cycle: true },
  { label: () => `SOUND:  ${Sound.muted ? 'OFF' : 'ON'}`, act: () => { Sound.muted = !Sound.muted; } },
];
const LEVELS = ['EASY', 'NORMAL', 'HARD'];
function cycleLevel(dir) { game.level = LEVELS[(LEVELS.indexOf(game.level) + dir + 3) % 3]; }
const menuRect = i => { const w = Math.min(440, W - 40); return { x: W / 2 - w / 2, y: 258 + i * (compact ? 56 : 52), w, h: compact ? 48 : 44 }; };

function update(dt) {
  game.t += dt;
  game.crowdHype = Math.max(0, game.crowdHype - dt * 0.25);
  if (pressed.has('KeyM')) Sound.muted = !Sound.muted;

  if (game.state === 'title') { updateTitle(); return; }
  if (game.state === 'select') { updateSelect(dt); return; }

  if (pressed.has('Escape') || pressed.has('KeyP')) {
    if (game.state === 'paused') { game.state = game.prevState; return; }
    if (['fight', 'intro', 'knockdown'].includes(game.state)) { game.prevState = game.state; game.state = 'paused'; return; }
  }
  if (game.state === 'paused') {
    const [rb, qb] = twoButtons(H / 2 + 60);
    if (pressed.has('KeyQ') || hitRect(qb, clickPos)) game.state = 'title';
    else if (clickPos) game.state = game.prevState;
    return;
  }

  if (game.state === 'entrance') { updateEntrance(dt); updateCamera(dt); updateFx(dt); return; }
  updateRef(dt);
  updateCamera(dt);
  if (hitstop > 0) { hitstop -= dt; updateFx(dt * 0.2); return; }

  const [p1, p2] = game.fighters;
  let i1 = emptyIntent(), i2 = emptyIntent();
  if (game.mode === 1) {
    i1 = readIntent(SOLO_KEYS);
    i2 = game.ai.intent(dt, p2, p1, game.state);
  } else {
    i1 = readIntent(P1_KEYS);
    i2 = readIntent(P2_KEYS);
  }

  const fighting = game.state === 'fight';
  p1.update(dt, i1, p2, fighting);
  p2.update(dt, i2, p1, fighting);

  // keep fighters apart
  if (p1.state !== 'down' && p2.state !== 'down') {
    const dx = p2.x - p1.x, gap = Math.abs(dx);
    if (gap < MIN_SEP) {
      const push = (MIN_SEP - gap) / 2 * (dx >= 0 ? 1 : -1);
      p1.x = clamp(p1.x - push, RING_L, RING_R);
      p2.x = clamp(p2.x + push, RING_L, RING_R);
      if (Math.abs(p2.x - p1.x) < MIN_SEP) { // pinned against ropes
        if (p1.x <= RING_L + 1) p2.x = p1.x + MIN_SEP; else if (p2.x <= RING_L + 1) p1.x = p2.x + MIN_SEP;
        if (p1.x >= RING_R - 1) p2.x = p1.x - MIN_SEP; else if (p2.x >= RING_R - 1) p1.x = p2.x - MIN_SEP;
      }
    }
  }

  switch (game.state) {
    case 'intro':
      if (game.t > 2.2) { game.state = 'fight'; game.t = 0; Sound.crowd(0.15); }
      break;
    case 'fight':
      game.timer -= dt;
      if (game.timer <= 0) {
        game.timer = 0;
        const s1 = p1.hp - p1.knockdowns * 25, s2 = p2.hp - p2.knockdowns * 25;
        game.endRound(Math.abs(s1 - s2) < 1 ? null : s1 > s2 ? p1 : p2, 'TIME!  DECISION');
      }
      break;
    case 'knockdown': updateKnockdown(dt, game.mode === 1 && game.downed === p2 ? i2 : game.downed === p1 ? i1 : i2); break;
    case 'roundEnd':
      if (game.t > 3.5) {
        if (p1.wins >= WINS_NEEDED || p2.wins >= WINS_NEEDED) {
          const w = p1.wins >= WINS_NEEDED && p2.wins >= WINS_NEEDED ? null : p1.wins >= WINS_NEEDED ? p1 : p2;
          startCeremony(w);
        } else { game.round++; game.startRound(); }
      }
      break;
    case 'matchEnd':
      updateCeremony(dt);
      if (game.ceremonyT > 2.2) {
        const [rb, mb] = twoButtons(H - 62);
        if (pressed.has('KeyR') || hitRect(rb, clickPos)) game.start(game.mode);
        else if (pressed.has('Enter') || pressed.has('Space') || pressed.has('Escape') || hitRect(mb, clickPos)) game.state = 'title';
      }
      break;
  }
  updateFx(dt);
}

function updateKnockdown(dt, intent) {
  const f = game.downed, by = game.by;
  // standing fighter walks to a neutral spot
  const home = f.x < (RING_L + RING_R) / 2 ? RING_R - 120 : RING_L + 120;
  if (by.state !== 'down') {
    const d = home - by.x;
    if (Math.abs(d) > 10) { by.vx = Math.sign(d) * 160; by.state = 'walk'; by.walkT += dt * (Math.sign(d) === by.facing ? 1 : -1); }
    else { by.vx = 0; by.state = 'idle'; }
    by.facing = f.x > by.x ? 1 : -1;
  }
  if (game.t < 1) return;
  if (f.knockdowns >= 3) {
    if (game.t > 2) { f.state = 'ko'; game.endRound(by, 'T.K.O.!'); }
    return;
  }
  if (intent.mash) {
    f.getupProgress++;
    f.wiggle = 0.12;
    if (Math.random() < 0.15) Sound.voice(f.look, 1.3);
    f.popV -= 30; // shoving the head back down
  }
  f.wiggle = Math.max(0, (f.wiggle || 0) - dt);
  game.countT += dt;
  if (game.countT >= 1) {
    game.countT -= 1; game.count++;
    Sound.count();
    if (game.count >= 10) { f.state = 'ko'; game.endRound(by, 'KNOCKOUT!'); return; }
  }
  if (f.getupProgress >= game.need) {
    f.hp = Math.max(15, 50 - 12 * f.knockdowns);
    f.toIdle(); f.stamina = 60;
    popup("HEAD'S BACK ON!", f.x, GROUND - 230, '#9cf59c', 28);
    Sound.select();
    Sound.crowd(0.25);
    game.state = 'intro'; game.t = 1.2; // short "FIGHT!" restart
    ref.gesture = 'point'; setTimeout(() => { if (game.state !== 'knockdown') refLeave(); }, 500);
  }
}

// ---------------------------------------------------------------- character select
const CARD_H = 330, CARD_Y = 96;
const cardW = () => (compact ? 136 : 200), cardGap = () => (compact ? 10 : 16);
const cardX = i => W / 2 - (ROSTER.length * (cardW() + cardGap()) - cardGap()) / 2 + i * (cardW() + cardGap());

function openSelect(mode) {
  game.mode = mode;
  game.state = 'select'; game.t = 0;
  game.sel = { p1: 0, p2: 1, r1: false, r2: false };
  game.previews = ROSTER.map(l => new Fighter(l, 0));
}

function updateSelect(dt) {
  const s = game.sel, n = ROSTER.length;
  game.previews.forEach(f => { f.t += dt; f.updatePop(dt, 0); });
  updateFx(dt);
  if (pressed.has('Escape')) { game.state = 'title'; return; }
  const confirm = (who) => {
    const mine = who === 1 ? s.p1 : s.p2, other = who === 1 ? s.p2 : s.p1, otherReady = who === 1 ? s.r2 : s.r1;
    if (game.mode === 2 && otherReady && mine === other) { Sound.tone(120, 0.15, 'square', 0.1); return; }
    if (who === 1) s.r1 = true; else s.r2 = true;
    game.previews[mine].popV = 700; // head pops for a peek
    Sound.boing(); Sound.voice(ROSTER[mine]);
  };
  const step = (who, d) => {
    if (who === 1 && !s.r1) s.p1 = (s.p1 + d + n) % n;
    if (who === 2 && !s.r2) s.p2 = (s.p2 + d + n) % n;
    Sound.select();
  };
  const ctl1 = game.mode === 1 ? SOLO_KEYS : P1_KEYS;
  if (anyOf(pressed, ctl1.left)) step(1, -1);
  if (anyOf(pressed, ctl1.right)) step(1, 1);
  if (!s.r1 && (anyOf(pressed, ctl1.jab) || (game.mode === 1 && (pressed.has('Enter') || pressed.has('Space'))))) confirm(1);
  else if (s.r1 && anyOf(pressed, ctl1.block)) s.r1 = false;
  if (game.mode === 2) {
    if (anyOf(pressed, P2_KEYS.left)) step(2, -1);
    if (anyOf(pressed, P2_KEYS.right)) step(2, 1);
    if (!s.r2 && (anyOf(pressed, P2_KEYS.jab) || pressed.has('Enter'))) confirm(2);
    else if (s.r2 && anyOf(pressed, P2_KEYS.block)) s.r2 = false;
  }
  if (clickPos) {
    ROSTER.forEach((_, i) => {
      const x = cardX(i);
      if (clickPos.x > x && clickPos.x < x + cardW() && clickPos.y > CARD_Y && clickPos.y < CARD_Y + CARD_H) {
        if (!s.r1) { s.p1 = i; confirm(1); } else if (game.mode === 2 && !s.r2) { s.p2 = i; confirm(2); }
      }
    });
  }
  if (game.mode === 1 && s.r1 && !s.r2) {
    const others = ROSTER.map((_, i) => i).filter(i => i !== s.p1);
    s.p2 = others[Math.floor(rand(others.length))]; s.r2 = true; s.readyT = game.t;
  }
  if (s.r1 && s.r2) {
    if (s.readyT === undefined) s.readyT = game.t;
    if (game.t - s.readyT > 1.1) { s.readyT = undefined; game.start(game.mode); }
  } else s.readyT = undefined;
}

function drawSelect() {
  inWorld((WW - W) / 2, drawBackground);
  ctx.fillStyle = 'rgba(10,5,2,0.7)'; ctx.fillRect(0, 0, W, H);
  text('CHOOSE YOUR MASCOT', W / 2, 52, fz(44), '#ffe08a', 'center', '#3a0606');
  const s = game.sel, CW = cardW();
  ROSTER.forEach((L, i) => {
    const x = cardX(i), h1 = s.p1 === i, h2 = s.p2 === i && (game.mode === 2 || s.r2);
    roundRect(x, CARD_Y, CW, CARD_H, 14, h1 || h2 ? '#3a1d10' : '#1c120bdd', h1 && h2 ? '#c792ea' : h1 ? '#ff5a3c' : h2 ? '#4f9dff' : '#ffffff30', h1 || h2 ? 5 : 2);
    const f = game.previews[i];
    f.x = 0; f.facing = 1; f.state = 'idle';
    const sc = compact ? 0.62 : 0.82;
    ctx.save();
    ctx.translate(x + CW / 2 - 8, CARD_Y + 236); ctx.scale(sc, sc); ctx.translate(0, -GROUND);
    drawFighter(f);
    ctx.restore();
    if (compact) {
      text(L.name.replace(' BRUISER', ''), x + CW / 2, CARD_Y + 262, 19, '#fff');
      text(L.suit, x + CW / 2, CARD_Y + 286, 13, '#e8c15a', 'center', null, 700);
      text('inside: ' + L.person.name, x + CW / 2, CARD_Y + 306, 12, '#bbb', 'center', null, 600);
    } else {
      text(L.name, x + CW / 2, CARD_Y + 262, L.name.length > 10 ? 19 : 24, '#fff');
      text(L.suit + ' · ' + L.special, x + CW / 2, CARD_Y + 285, 11, '#e8c15a', 'center', null, 700);
      text('inside: ' + L.person.bio, x + CW / 2, CARD_Y + 305, 11, '#bbb', 'center', null, 600);
    }
    const tags = [];
    if (h1) tags.push([game.mode === 1 ? 'YOU' : 'P1', '#ff5a3c', s.r1]);
    if (h2) tags.push([game.mode === 1 ? 'CPU' : 'P2', '#4f9dff', s.r2]);
    tags.forEach(([t, c, r], k) => {
      const tx = x + CW / 2 + (tags.length > 1 ? (k ? 34 : -34) : 0);
      roundRect(tx - 32, CARD_Y - 14, 64, 26, 13, r ? c : '#000', c, 3);
      text(r ? t + ' ✓' : t, tx, CARD_Y - 1, 14, '#fff', 'center', null, 800);
    });
  });
  if (compact) {
    const L = ROSTER[s.p1];
    text(`${L.name}: ${L.person.bio} · ${L.special}`, W / 2, CARD_Y + CARD_H + 26, 14, '#e8c15a', 'center', null, 700);
  }
  const help = isTouch ? 'Tap a mascot to pick it'
    : game.mode === 1 ? '←/→ or A/D to choose · Enter / F / click to pick · Esc = back'
    : compact ? 'P1: A/D + F    P2: ←/→ + J    Esc = back'
    : 'P1: A/D choose, F pick, S undo      P2: ←/→ choose, J pick, ↓ undo      Esc = back';
  text(help, W / 2, H - 40, fz(16), '#ddd', 'center', null, 700);
}

// ---------------------------------------------------------------- referee (a person in a zebra suit)
const REF_OFF = WW + 90;
const ref = { x: REF_OFF, targetX: REF_OFF, facing: -1, walkT: 0, moving: false, gesture: 'none', k: 0, faceTo: null, handTo: null, speed: 300 };

function refGoTo(x, gesture = 'none', faceTo = null) {
  ref.targetX = x; ref.gesture = gesture; ref.faceTo = faceTo; ref.k = 0;
}
function refLeave() { refGoTo(REF_OFF); }

function updateRef(dt) {
  const d = ref.targetX - ref.x;
  ref.moving = Math.abs(d) > 3;
  if (ref.moving) {
    ref.x += Math.sign(d) * Math.min(Math.abs(d), ref.speed * dt);
    ref.walkT += dt; ref.facing = Math.sign(d);
  } else if (ref.faceTo !== null) ref.facing = ref.faceTo > ref.x ? 1 : -1;
}

function drawReferee() {
  const r = ref;
  if (r.x > WW + 60 || r.x < -60) return;
  ctx.save();
  ctx.translate(r.x, GROUND);
  ellipse(0, 4, 34, 8, 'rgba(0,0,0,0.25)');
  ctx.scale(r.facing, 1);
  const walk = r.moving ? Math.sin(r.walkT * 13) : 0;
  const bob = r.moving ? -Math.abs(walk) * 3 : Math.sin(game.t * 4) * 1.5;
  ctx.lineCap = 'round';
  // trousers + shoes
  for (const [lx, ph] of [[-8, walk], [8, -walk]]) {
    ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 13;
    ctx.beginPath(); ctx.moveTo(lx, -72 + bob); ctx.lineTo(lx + ph * 12, -8); ctx.stroke();
    roundRect(lx + ph * 12 - 7, -9, 20, 9, 4, '#000');
  }
  // hand targets (local coords)
  const toLocal = p => ({ x: (p.x - r.x) * r.facing, y: p.y - GROUND });
  let front = { x: 12, y: -92 }, back = { x: -12, y: -94 };
  if (r.gesture === 'count') {
    const k = 1 - Math.min(1, game.countT * 4); // chop down each second
    front = { x: lerp(46, 26, k), y: lerp(-104, -196, k) };
    back = { x: -8, y: -100 };
  } else if (r.gesture === 'apart') {
    const s = Math.sin(game.t * 3) * 6;
    front = { x: 54, y: -146 + s }; back = { x: -52, y: -146 - s };
  } else if (r.gesture === 'raise' && r.handTo) {
    const t = toLocal(r.handTo);
    front = { x: lerp(20, t.x, r.k), y: lerp(-110, t.y, r.k) };
    back = { x: -14, y: -104 };
  } else if (r.gesture === 'draw') {
    const s = Math.sin(game.t * 6) * 6;
    front = { x: 30, y: -204 + s }; back = { x: -24, y: -204 - s };
  } else if (r.gesture === 'point') {
    front = { x: 58, y: -150 }; back = { x: -12, y: -98 };
  }
  const sleeve = (sx, sy, h) => {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(h.x, h.y); ctx.stroke();
    ctx.strokeStyle = '#fafafa'; ctx.lineWidth = 8; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(h.x, h.y); ctx.stroke();
    ctx.setLineDash([]);
    circle(h.x, h.y, 7, '#fff');
    ctx.strokeStyle = '#0005'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(h.x, h.y, 7, 0, 7); ctx.stroke();
  };
  sleeve(-6, -142 + bob, back);
  // striped zebra-suit / referee shirt
  ctx.save();
  ctx.beginPath(); ctx.roundRect(-26, -154 + bob, 52, 86, 16); ctx.clip();
  ctx.fillStyle = '#fafafa'; ctx.fillRect(-30, -160 + bob, 60, 96);
  ctx.fillStyle = '#151515';
  for (let i = -30; i < 30; i += 12) ctx.fillRect(i, -160 + bob, 6, 96);
  ctx.restore();
  ctx.fillStyle = '#111'; ctx.fillRect(-27, -76 + bob, 54, 7); // belt
  // bow tie
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.moveTo(12, -150 + bob); ctx.lineTo(4, -156 + bob); ctx.lineTo(4, -144 + bob); ctx.fill();
  ctx.beginPath(); ctx.moveTo(12, -150 + bob); ctx.lineTo(20, -156 + bob); ctx.lineTo(20, -144 + bob); ctx.fill();
  // zebra head
  ctx.save(); ctx.translate(6, -178 + bob);
  ctx.fillStyle = '#111';
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(-18 + i * 6, -16 + i * 2); ctx.lineTo(-24 + i * 6, -30 + i * 2); ctx.lineTo(-12 + i * 6, -18 + i * 2); ctx.fill(); } // mane
  ellipse(-6, -24, 5, 11, '#fafafa', -0.3); ellipse(4, -26, 5, 11, '#fafafa', 0.2); // ears
  ellipse(0, 0, 21, 25, '#fafafa');
  ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 21, 25, 0, 0, 7); ctx.clip();
  ctx.strokeStyle = '#151515'; ctx.lineWidth = 4;
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(-26, -14 + i * 11, 22, -0.5, 0.5); ctx.stroke(); }
  ctx.restore();
  ellipse(17, 12, 12, 10, '#2b2b2b'); // muzzle
  circle(23, 9, 2, '#000');
  circle(7, -6, 5, '#fff'); circle(8.5, -6, 2.6, '#111');
  // whistle
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(14, 18); ctx.lineTo(4, 30); ctx.stroke();
  roundRect(1, 28, 9, 6, 2, '#c0c0c0');
  ctx.restore();
  sleeve(8, -140 + bob, front);
  ctx.restore();
}

// ---------------------------------------------------------------- ring entrances (before round 1)
const NICKNAMES = { NUGGET: 'The Crispy Crusher', 'BIG RED': 'The Cock-a-Doodle-Doom', 'BESSIE BRUISER': 'The Moo-ving Mountain', HAMHOCK: 'The Hog of War' };
const E_P1 = 0.5, E_P2 = 4.2, E_REF = 7.9, E_END = 10.4;
const homeX = f => (f.side === 0 ? RING_L + 130 : RING_R - 130);

function beginEntrances() {
  const [p1, p2] = game.fighters;
  p1.x = -90; p2.x = WW + 90; p1.facing = 1; p2.facing = -1;
  [p1, p2].forEach(f => { f.state = 'idle'; f.record = `${Math.floor(rand(9, 31))}-${Math.floor(rand(0, 8))}`; f.announced = false; });
  ref.x = WW / 2; refGoTo(WW / 2, 'none', null); ref.facing = 1;
  game.state = 'entrance'; game.t = 0;
}

function entranceWalk(f, dt) {
  const d = homeX(f) - f.x;
  if (Math.abs(d) > 3) {
    f.x += Math.sign(d) * Math.min(Math.abs(d), 165 * dt);
    f.state = 'walk'; f.walkT += dt; f.facing = Math.sign(d);
    f.taunt = false;
  } else {
    f.x = homeX(f); f.state = 'idle'; f.facing = f.side === 0 ? 1 : -1;
    if (!f.taunt && !f.taunted) { f.taunt = true; f.taunted = true; Sound.call(f.look); Sound.crowd(0.3); game.crowdHype = 1; }
  }
}

function updateEntrance(dt) {
  const [p1, p2] = game.fighters;
  const t = game.t;
  [p1, p2].forEach(f => { f.t += dt; f.updatePop(dt, 0); });
  if (t > E_P1) {
    if (!p1.announced) { p1.announced = true; Sound.fanfare(); }
    entranceWalk(p1, dt);
  }
  if (t > E_P2) {
    p1.taunt = false;
    if (!p2.announced) { p2.announced = true; Sound.fanfare(1.12); }
    entranceWalk(p2, dt);
  }
  if (t > E_REF) {
    p2.taunt = false;
    if (ref.gesture !== 'apart') { refGoTo(WW / 2, 'apart', null); Sound.tone(1800, 0.25, 'sine', 0.12); }
  }
  game.camFocus = t < E_P2 ? Math.max(p1.x, RING_L) : t < E_REF ? Math.min(p2.x, RING_R) : WW / 2;
  const skip = t > 0.4 && (clickPos || pressed.has('Enter') || pressed.has('Space') || pressed.has('KeyF') || pressed.has('KeyJ'));
  if (t > E_END || skip) finishEntrances();
  updateRef(dt);
  game.crowdHype = Math.max(game.crowdHype, 0.3);
}

function finishEntrances() {
  game.fighters.forEach(f => { f.x = homeX(f); f.facing = f.side === 0 ? 1 : -1; f.taunt = false; f.state = 'idle'; });
  game.camFocus = null;
  refLeave();
  game.state = 'intro'; game.t = 0;
  Sound.bell(1);
}

function drawEntranceOverlay() {
  const [p1, p2] = game.fighters;
  const t = game.t;
  const f = t < E_P2 ? p1 : t < E_REF ? p2 : null;
  // spotlight on whoever is being announced
  const fx = (f ? f.x : WW / 2) - (game.camX || 0);
  const g = ctx.createRadialGradient(fx, GROUND - 110, 70, fx, GROUND - 110, 300);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
  // announcer card
  const since = f ? t - (f === p1 ? E_P1 : E_P2) : t - E_REF;
  const slide = easeOut(Math.min(1, since * 3));
  ctx.save(); ctx.translate((1 - slide) * (f === p2 ? W : -W), 0);
  ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 34, W, compact ? 168 : 150);
  ctx.fillStyle = f === p2 ? '#1e63d6' : f === p1 ? '#c62828' : '#e8c15a'; ctx.fillRect(0, 34, W, 5);
  if (f) {
    const L = f.look;
    text(f === p1 ? 'IN THE RED CORNER...' : 'AND IN THE BLUE CORNER...', W / 2, 60, fz(20), f === p1 ? '#ff8a80' : '#82b1ff', 'center', '#000', 800);
    if (since > 0.5) {
      text(`"${NICKNAMES[L.name] || 'The Contender'}"`, W / 2, 90, fz(22), '#e8c15a', 'center', '#000', 700);
      text(L.name + '!', W / 2, 128, fz(52), '#fff', 'center', '#3a0606');
      const info = compact ? `${L.person.bio} · Record ${f.record}` : `Record ${f.record}  ·  inside the ${L.suit.toLowerCase()}: ${L.person.bio}`;
      text(info, W / 2, compact ? 172 : 166, fz(16), '#ddd', 'center', '#000', 600);
    }
  } else {
    text('THE REFEREE:', W / 2, 62, fz(20), '#e8c15a', 'center', '#000', 800);
    text('"Keep it clean! No pecking,', W / 2, 100, fz(30), '#fff');
    text('no biting, no tail-pulling!"', W / 2, 140, fz(30), '#fff');
  }
  ctx.restore();
  if (t > 0.6) text(isTouch ? 'tap to skip' : 'Enter / click to skip', W - 12, H - 16, 13, '#fff9', 'right', '#000', 600);
}

// ---------------------------------------------------------------- winner ceremony
function startCeremony(w) {
  const [p1, p2] = game.fighters;
  game.state = 'matchEnd'; game.t = 0; game.winner = w; game.ceremonyT = 0; game.cheered = false;
  const cx = clamp((p1.x + p2.x) / 2, RING_L + 80, RING_R - 80);
  game.fighters.forEach(f => {
    f.taunt = false; f.raised = false; f.raiseK = 0;
    if (f !== w && f.state !== 'ko') { f.toIdle(); f.dejected = true; }
  });
  if (w) { w.toIdle(); w.raised = true; refGoTo(cx, 'none', null); }
  else refGoTo(cx, 'draw', null);
  ref.speed = 300;
}

function updateCeremony(dt) {
  const w = game.winner;
  game.camFocus = ref.x;
  if (!w) {
    if (!ref.moving) game.ceremonyT += dt;
  } else if (!ref.moving) {
    const side = w.x < ref.x ? -1 : 1;
    const tx = clamp(ref.x + side * 86, RING_L - 30, RING_R + 30);
    const d = tx - w.x;
    if (Math.abs(d) > 3) {
      w.x += Math.sign(d) * Math.min(Math.abs(d), 170 * dt);
      w.state = 'walk'; w.walkT += dt * (Math.sign(d) === -side ? 1 : -1);
    } else {
      w.x = tx; w.state = 'idle';
      game.ceremonyT += dt;
    }
    w.facing = -side; ref.facing = side;
    ref.gesture = 'raise';
    const ct = game.ceremonyT;
    const k = clamp((ct - 1.0) / 0.35, 0, 1);
    w.raiseK = k; ref.k = k;
    // winner's raised glove in world coordinates (matches poseFor 'raised')
    ref.handTo = { x: w.x + w.facing * lerp(46, 40, k), y: GROUND + lerp(-84, -198, k) + OY + 16 };
  }
  if (game.ceremonyT > 1.1 && !game.cheered) {
    game.cheered = true;
    Sound.bell(2); Sound.crowd(0.45); game.crowdHype = 1;
    if (w) {
      Sound.call(w.look);
      for (const c of ['#ff5252', '#ffd54f', '#69f0ae', '#40c4ff', '#e040fb']) feathers(w.x, GROUND - 230, 10, c);
    }
  }
  if (game.cheered && Math.random() < dt * 4 && w) {
    feathers(w.x + rand(-200, 200), GROUND - 300, 2, ['#ff5252', '#ffd54f', '#69f0ae', '#40c4ff'][Math.floor(rand(4))]);
  }
}

function updateCamera(dt) {
  let target = (WW - W) / 2;
  if (W < WW && game.camFocus != null) target = clamp(game.camFocus - W / 2, 0, WW - W);
  else if (W < WW && game.fighters.length) {
    const [a, b] = game.fighters;
    target = clamp((a.x + b.x) / 2 - W / 2, 0, WW - W);
  }
  game.camX = game.camX === undefined ? target : lerp(game.camX, target, 1 - Math.pow(0.02, dt));
  game.camX = clamp(game.camX, 0, Math.max(0, WW - W));
}

function updateTitle() {
  if (!game.titleFighters) game.titleFighters = [new Fighter(ROSTER[0], 0), new Fighter(ROSTER[1], 1)];
  game.titleFighters.forEach((f, i) => { f.t += 1 / 60; f.updatePop(1 / 60, ((game.t + i * 2.5) % 5) > 3.6 ? 100 : 0); });
  const n = MENU.length;
  if (pressed.has('ArrowUp') || pressed.has('KeyW')) { game.menuIndex = (game.menuIndex + n - 1) % n; Sound.select(); }
  if (pressed.has('ArrowDown') || pressed.has('KeyS')) { game.menuIndex = (game.menuIndex + 1) % n; Sound.select(); }
  const item = MENU[game.menuIndex];
  if (item.cycle && (pressed.has('ArrowLeft') || pressed.has('KeyA'))) { item.act(-1); Sound.select(); }
  if (item.cycle && (pressed.has('ArrowRight') || pressed.has('KeyD'))) { item.act(1); Sound.select(); }
  if (pressed.has('Enter') || pressed.has('Space')) { Sound.select(); item.act(); }
  if (clickPos) {
    MENU.forEach((m, i) => {
      const r = menuRect(i);
      if (clickPos.x > r.x && clickPos.x < r.x + r.w && clickPos.y > r.y && clickPos.y < r.y + r.h) {
        game.menuIndex = i; Sound.select();
        m.act(m.cycle && clickPos.x < r.x + r.w / 2 ? -1 : 1);
      }
    });
  }
  updateFx(1 / 60);
}

// ---------------------------------------------------------------- drawing helpers
function ellipse(x, y, rx, ry, fill, rot = 0) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function circle(x, y, r, fill) { ellipse(x, y, r, r, fill); }
function text(str, x, y, size, color = '#fff', align = 'center', stroke = '#000', weight = 900) {
  ctx.font = `${weight} ${size}px "Trebuchet MS", "Arial Black", sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size / 7); ctx.strokeStyle = stroke; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
}
function roundRect(x, y, w, h, r, fill, stroke, lw = 2) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

// ---------------------------------------------------------------- background
const crowd = [];
for (let row = 0; row < 3; row++) {
  for (let i = 0; i < 26; i++) {
    crowd.push({
      x: i * 38 + (row % 2) * 19 + rand(-6, 6), y: 250 + row * 26, row,
      c: ['#ffe27a', '#fff6d5', '#c9874a', '#f3c94d', '#8b5a2b'][Math.floor(rand(5))], ph: rand(10), s: rand(0.85, 1.1),
    });
  }
}

function drawBackground() {
  // barn wall
  const g = ctx.createLinearGradient(0, 0, 0, 330);
  g.addColorStop(0, '#2a160b'); g.addColorStop(1, '#5a321a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, WW, 340);
  ctx.strokeStyle = '#00000040'; ctx.lineWidth = 2;
  for (let x = 0; x < WW; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 340); ctx.stroke(); }
  // rafters
  ctx.fillStyle = '#24130a'; ctx.fillRect(0, 34, WW, 18);
  for (let x = 60; x < WW; x += 210) { ctx.save(); ctx.translate(x, 52); ctx.rotate(0.6); ctx.fillRect(0, -6, 90, 12); ctx.restore(); }
  // spotlights
  for (const lx of [WW * 0.3, WW * 0.7]) {
    const sg = ctx.createRadialGradient(lx, 60, 10, lx, 380, 360);
    sg.addColorStop(0, 'rgba(255,240,190,0.35)'); sg.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(lx - 20, 40); ctx.lineTo(lx + 20, 40); ctx.lineTo(lx + 260, 470); ctx.lineTo(lx - 260, 470); ctx.closePath(); ctx.fill();
    circle(lx, 40, 14, '#fff3c4');
  }
  // banner


  // crowd of chicks
  const hype = game.crowdHype;
  for (const c of crowd) {
    const bob = Math.abs(Math.sin(game.t * (3 + hype * 8) + c.ph)) * (2 + hype * 10);
    const y = c.y - bob;
    ctx.save(); ctx.translate(c.x, y); ctx.scale(c.s, c.s);
    ellipse(0, 10, 15, 13, c.c);
    circle(0, -6, 10, c.c);
    ctx.fillStyle = '#ff9f1a'; ctx.beginPath(); ctx.moveTo(-3, -4); ctx.lineTo(3, -4); ctx.lineTo(0, 2); ctx.fill();
    circle(-4, -8, 1.8, '#111'); circle(4, -8, 1.8, '#111');
    if (hype > 0.5 && Math.sin(c.ph * 7) > 0) { ctx.strokeStyle = c.c; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-10, 6); ctx.lineTo(-18, -8 - bob); ctx.moveTo(10, 6); ctx.lineTo(18, -8 - bob); ctx.stroke(); }
    ctx.restore();
  }
  // apron & ring floor
  ctx.fillStyle = '#20232b'; ctx.fillRect(0, 330, WW, 30);
  const fg = ctx.createLinearGradient(0, 360, 0, 480);
  fg.addColorStop(0, '#d9d3c4'); fg.addColorStop(1, '#bdb5a2');
  ctx.fillStyle = fg;
  ctx.beginPath(); ctx.moveTo(90, 360); ctx.lineTo(WW - 90, 360); ctx.lineTo(WW - 20, 480); ctx.lineTo(20, 480); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#9a1b1b'; ctx.fillRect(0, 480, WW, 60);
  ctx.fillStyle = '#7a1212'; ctx.fillRect(0, 480, WW, 8);
  text('★  BARNYARD BOXING ASSOCIATION  ★', WW / 2, 512, 18, '#f3d27a', 'center', null, 700);
  // hay
  ctx.strokeStyle = '#c9a44a88'; ctx.lineWidth = 2;
  for (let i = 0; i < 40; i++) { const hx = (i * 97) % WW, hy = 368 + ((i * 53) % 100); ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + 10, hy - 3); ctx.stroke(); }
  // back ropes + posts
  drawPost(105, 360); drawPost(WW - 105, 360);
  ['#d32f2f', '#f5f5f5', '#1e63d6'].forEach((c, i) => {
    ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(105, 290 + i * 24); ctx.lineTo(WW - 105, 290 + i * 24); ctx.stroke();
  });
}
function drawPost(x, y) {
  ctx.fillStyle = '#c0c4cc'; ctx.fillRect(x - 6, y - 90, 12, 90);
  ctx.fillStyle = '#d32f2f'; ctx.fillRect(x - 9, y - 80, 18, 70);
}
function drawFrontRopes() {
  ctx.fillStyle = '#c0c4cc'; ctx.fillRect(18, 380, 14, 100); ctx.fillRect(WW - 32, 380, 14, 100);
  ctx.fillStyle = '#1e63d6'; ctx.fillRect(14, 392, 22, 78); ctx.fillStyle = '#d32f2f'; ctx.fillRect(WW - 36, 392, 22, 78);
  ['#d32f2f', '#f5f5f5', '#1e63d6'].forEach((c, i) => {
    ctx.strokeStyle = c; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(25, 400 + i * 24); ctx.lineTo(WW - 25, 400 + i * 24); ctx.stroke();
  });
}

// ---------------------------------------------------------------- chicken
function drawGlove(x, y, color, r = 15) {
  circle(x, y, r, color);
  circle(x + r * 0.25, y - r * 0.3, r * 0.4, 'rgba(255,255,255,0.35)');
  ctx.fillStyle = '#fff'; ctx.save(); ctx.translate(x, y); ctx.fillRect(-r - 6, -r * 0.55, 8, r * 1.1); ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
}

function poseFor(f) {
  const bob = (f.state === 'idle' || f.state === 'block') ? Math.sin(game.t * 5 + f.phase) * 3 : 0;
  const p = {
    lean: 0, drop: 0, bob,
    front: { x: 46, y: -84 }, back: { x: 30, y: -100 },
    headTilt: 0, legPhase: 0, squint: false, ko: false, speed: false,
  };
  const t = f.t;
  switch (f.state) {
    case 'walk':
      p.legPhase = Math.sin(f.walkT * 14); p.bob = Math.abs(p.legPhase) * -3; break;
    case 'block':
      p.front = { x: 42, y: -80 }; p.back = { x: 38, y: -108 }; p.lean = -2; p.drop = 4; p.squint = true; break;
    case 'attack': {
      const a = ATK[f.atk], s = a.start * f.slow, ac = a.active, r = a.rec * f.slow;
      let k; // 0..1 extension
      if (t < s) k = -(t / s); else if (t < s + ac) k = 1; else k = 1 - easeOut((t - s - ac) / r);
      if (f.atk === 'jab') {
        p.front = { x: 46 + (k > 0 ? k * 62 : k * 10), y: -88 - Math.max(0, k) * 6 }; p.lean = Math.max(0, k) * 8;
      } else if (f.atk === 'hook') {
        if (k < 0) { p.back = { x: 30 + k * 40, y: -96 }; p.lean = k * 8; }
        else { const ang = lerp(Math.PI * 0.95, Math.PI * 0.1, Math.min(1, k * 1.2)); p.back = { x: 20 + Math.cos(Math.PI - ang) * 80, y: -100 - Math.sin(ang) * 18 }; p.lean = k * 14; }
        p.front = { x: 36, y: -78 };
      } else {
        if (k < 0) { p.lean = k * 16; p.drop = -k * 10; p.front = { x: 20, y: -80 }; p.back = { x: 10, y: -96 }; }
        else { p.lean = 22 * k; p.front = { x: 46 + 50 * k, y: -92 }; p.back = { x: 36 + 46 * k, y: -76 }; p.speed = t >= s && t < s + ac; }
      }
      break;
    }
    case 'hit':
      p.lean = -18 * (1 - t / f.stun); p.headTilt = -0.4 * (1 - t / f.stun); p.squint = true;
      p.front = { x: 30, y: -70 }; p.back = { x: 14, y: -112 }; break;
    case 'dodge':
      p.lean = -20; p.drop = 14; p.front = { x: 34, y: -74 }; p.back = { x: 26, y: -92 }; break;
    case 'down': case 'ko': // slumped, arms dangling
      p.ko = true; p.lean = -8; p.drop = 8; p.front = { x: 28, y: -40 }; p.back = { x: 8, y: -46 }; break;
  }
  if (f.taunt) { // entrance showboating
    const w = Math.sin(game.t * 8) * 6;
    p.front = { x: 34, y: -150 + w }; p.back = { x: 4, y: -150 - w }; p.bob = Math.abs(Math.sin(game.t * 6)) * -10;
  }
  if (f.dejected) { p.lean = -4; p.drop = 6; p.front = { x: 30, y: -48 }; p.back = { x: 10, y: -54 }; p.headTilt = 0.35; }
  if (f.raised && f.state === 'idle') { // ref holds the winner's glove up
    const k = f.raiseK;
    p.front = { x: lerp(46, 40, k), y: lerp(-84, -198, k) }; p.bob = 0; p.lean = 0; p.drop = 0;
    if (k > 0.95) p.back = { x: 8, y: -146 + Math.sin(game.t * 10) * 8 };
  }
  return p;
}

const OY = -22; // costumed people are taller than chickens: shift glove poses up

function drawSpring(x1, y1, x2, y2) {
  const n = 9, w = 11;
  ctx.lineCap = 'round';
  for (const [col, lw] of [['#6d6d6d', 5], ['#d7d7d7', 2.5]]) {
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x1, y1);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      ctx.lineTo(lerp(x1, x2, k) + (i % 2 ? w : -w), lerp(y1, y2, k));
    }
    ctx.lineTo(x2, y2); ctx.stroke();
  }
}

// the poor soul inside the suit (side profile, facing right)
function drawPerson(P, px, py, f, pop) {
  const dazed = pop > 50;
  ctx.save(); ctx.translate(px, py); ctx.scale(1.35, 1.35);
  const x = 0, y = 0;
  // hair behind head
  if (P.style === 'puff') circle(x - 4, y - 14, 15, P.hair);
  if (P.style === 'bun') circle(x - 14, y - 12, 7, P.hair);
  // ear + face
  circle(x, y, 15, P.skin);
  ellipse(x - 2, y + 1, 4, 5, shadeColor(P.skin, -25));
  // nose
  ellipse(x + 15, y - 1, 4, 3.5, P.skin);
  // hair on top
  ctx.fillStyle = P.hair;
  if (P.style === 'short') { ctx.beginPath(); ctx.arc(x, y - 2, 16, Math.PI * 1.02, Math.PI * 1.95); ctx.fill(); }
  if (P.style === 'bun' || P.style === 'puff') { ctx.beginPath(); ctx.arc(x, y - 1, 15.5, Math.PI * 1.0, Math.PI * 1.75); ctx.fill(); }
  if (P.style === 'bald') {
    ctx.beginPath(); ctx.arc(x - 3, y + 1, 15.5, Math.PI * 0.75, Math.PI * 1.1); ctx.fill(); // fringe
    ellipse(x + 3, y - 10, 5, 2.5, 'rgba(255,255,255,.5)', -0.3); // shiny dome
    ellipse(x + 11, y + 5, 6, 2.5, P.hair); // mustache
  }
  // eyes
  ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
  if (dazed) {
    ctx.beginPath(); ctx.moveTo(x + 5, y - 7); ctx.lineTo(x + 11, y - 1); ctx.moveTo(x + 11, y - 7); ctx.lineTo(x + 5, y - 1); ctx.stroke();
  } else {
    circle(x + 8, y - 4, 4, '#fff'); circle(x + 9.5, y - 4, 2, '#111');
  }
  // mouth: shocked "O"
  ellipse(x + 10, y + 9, 2.5, dazed ? 4 : 3, '#4a1a1a');
  // sweat
  if (pop > 15) {
    const d = (game.t * 2) % 1;
    ellipse(x - 8, y - 12 + d * 14, 2.5, 4, `rgba(120,200,255,${1 - d})`);
  }
  ctx.restore();
}

function drawMascotHead(L, x, y, f, tilt) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
  const t = L.type;
  if (t === 'chicken' || t === 'rooster') {
    const big = t === 'rooster';
    const comb = big ? [[-14, -24, 9], [-4, -32, 11], [8, -30, 10], [17, -22, 8]] : [[-9, -25, 8], [1, -29, 9], [11, -25, 8]];
    comb.forEach(([cx, cy, r]) => circle(cx, cy, r, L.comb));
    circle(0, 0, 29, L.body);
    ctx.fillStyle = '#ffa31a';
    ctx.beginPath(); ctx.moveTo(22, -7); ctx.lineTo(46, 2); ctx.lineTo(22, 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e07b00';
    ctx.beginPath(); ctx.moveTo(22, 2); ctx.lineTo(41, 2); ctx.lineTo(22, 10); ctx.closePath(); ctx.fill();
    ellipse(25, 18, 6, 11, L.comb);
  } else if (t === 'cow') {
    // horns + ears
    ctx.fillStyle = '#f3e3b5';
    ctx.beginPath(); ctx.moveTo(-14, -20); ctx.quadraticCurveTo(-24, -40, -10, -46); ctx.lineTo(-6, -24); ctx.fill();
    ctx.beginPath(); ctx.moveTo(4, -24); ctx.quadraticCurveTo(0, -44, 14, -48); ctx.lineTo(12, -24); ctx.fill();
    ellipse(-24, -12, 13, 6, L.shade, -0.5);
    ellipse(-24, -12, 8, 3, '#f4b6c2', -0.5);
    ellipse(0, 0, 29, 28, L.body);
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 29, 28, 0, 0, 7); ctx.clip();
    ellipse(-14, -14, 12, 9, '#222', 0.4); ellipse(-6, 18, 9, 7, '#222');
    ctx.restore();
    ellipse(24, 10, 15, 12, L.comb);
    ellipse(30, 7, 2.5, 3.5, '#a35c6c'); ellipse(22, 7, 2.5, 3.5, '#a35c6c');
    ctx.strokeStyle = '#a35c6c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(24, 14, 6, 0.3, 2.6); ctx.stroke();
  } else if (t === 'pig') {
    ctx.fillStyle = L.shade;
    ctx.beginPath(); ctx.moveTo(-20, -18); ctx.lineTo(-24, -42); ctx.lineTo(-4, -26); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -26); ctx.lineTo(8, -46); ctx.lineTo(16, -22); ctx.fill();
    circle(0, 0, 29, L.body);
    ellipse(-6, 12, 7, 5, 'rgba(230,90,120,.35)');
    ellipse(29, 4, 9, 13, L.comb);
    ellipse(31, 0, 2.5, 3.5, '#a3405c'); ellipse(31, 9, 2.5, 3.5, '#a3405c');
    ctx.strokeStyle = '#a3405c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(14, 16, 6, 0.2, 2.2); ctx.stroke();
  }
  // big fixed mascot eyes with jiggly pupils
  const jx = clamp(f.popV * 0.004, -3, 3), jy = clamp(Math.sin(game.t * 23) * f.popV * 0.004, -3, 3);
  circle(9, -8, 10, '#fff');
  ctx.strokeStyle = '#0004'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(9, -8, 10, 0, 7); ctx.stroke();
  circle(12 + jx, -8 + jy, 4.5, '#111');
  circle(13 + jx, -10 + jy, 1.5, '#fff');
  // felt eyebrow
  ctx.strokeStyle = shadeColor(L.shade, -60); ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, -21); ctx.lineTo(18, -16); ctx.stroke();
  ctx.restore();
}

function drawLegs(L, p, lean, by) {
  const bird = L.type === 'chicken' || L.type === 'rooster';
  ctx.lineCap = 'round';
  for (const [lx, ph] of [[-11, p.legPhase], [11, -p.legPhase]]) {
    const fx = lx + ph * 14 + lean * 0.2, fy = -Math.max(0, ph) * 6;
    ctx.strokeStyle = bird ? '#f39c12' : L.body; ctx.lineWidth = bird ? 8 : 13;
    ctx.beginPath(); ctx.moveTo(lx + lean * 0.4, -48 + by * 0.5); ctx.lineTo(fx, fy - 4); ctx.stroke();
    if (bird) {
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + 16, fy + 1); ctx.moveTo(fx, fy); ctx.lineTo(fx - 8, fy + 1); ctx.moveTo(fx, fy); ctx.lineTo(fx + 10, fy - 5); ctx.stroke();
    } else {
      if (L.type === 'cow') ellipse(fx + 1, fy - 22, 6, 5, '#222');
      roundRect(fx - 7, fy - 8, 16, 9, 3, '#3a2a22');
    }
  }
}

function drawTail(L, bx, byy) {
  if (L.tail) {
    L.tail.forEach((c, i) => ellipse(bx - 36 - i * 4, byy - 18 - i * 12, 12, 28, c, -0.5 - i * 0.35));
  } else if (L.type === 'cow') {
    ctx.strokeStyle = L.shade; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(bx - 34, byy - 6); ctx.quadraticCurveTo(bx - 58, byy + 4, bx - 52, byy + 32); ctx.stroke();
    ellipse(bx - 52, byy + 36, 5, 8, '#222');
  } else if (L.type === 'pig') {
    ctx.strokeStyle = L.shade; ctx.lineWidth = 4;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 4; a += 0.2) {
      const r = 3 + a * 1.2, px = bx - 44 + Math.cos(a) * r, py = byy - 2 + Math.sin(a) * r;
      a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawFighter(f) {
  const L = f.look, p = poseFor(f);
  ctx.save();
  ctx.translate(f.x, GROUND);
  ellipse(0, 4, 48, 9, 'rgba(0,0,0,0.28)');
  ctx.scale(f.facing, 1);
  if (f.flash > 0) ctx.filter = 'brightness(1.6)';

  const lean = p.lean, by = p.bob + p.drop;
  if (p.speed) {
    ctx.strokeStyle = 'rgba(255,220,120,0.7)'; ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const y = -150 + i * 24; ctx.beginPath(); ctx.moveTo(-60 - rand(40), y); ctx.lineTo(-20, y); ctx.stroke(); }
  }

  drawLegs(L, p, lean, by);
  const bx = lean * 0.5, byy = -88 + by;
  const neckX = bx + 10 + lean * 0.4, neckY = byy - 40;
  const g = (pt, d = 0) => ({ x: pt.x + lean * 0.6, y: pt.y + OY + by + d });

  // back arm
  const bg = g(p.back);
  ctx.strokeStyle = L.shade; ctx.lineWidth = 12; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(bx + 4, byy - 22); ctx.lineTo(bg.x, bg.y); ctx.stroke();
  drawGlove(bg.x, bg.y, shadeColor(L.glove, -25));

  drawTail(L, bx, byy);
  // suit body
  ellipse(bx, byy, 38, 46, L.body);
  ctx.save();
  ctx.beginPath(); ctx.ellipse(bx, byy, 38, 46, 0, 0, Math.PI * 2); ctx.clip();
  if (L.type === 'cow') { ellipse(bx - 16, byy - 18, 14, 10, '#222', 0.5); ellipse(bx + 18, byy - 2, 9, 12, '#222'); }
  if (L.type === 'pig') ellipse(bx + 14, byy - 4, 18, 26, 'rgba(255,255,255,.25)');
  if (L.tail) ellipse(bx - 8, byy - 10, 20, 15, L.shade, 0.3);
  ctx.fillStyle = L.shorts; ctx.fillRect(bx - 50, byy + 12, 100, 40);
  ctx.fillStyle = L.trim; ctx.fillRect(bx - 50, byy + 10, 100, 6);
  // costume zipper down the back
  ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bx - 27, byy - 34); ctx.lineTo(bx - 37, byy + 8); ctx.stroke();
  for (let i = 0; i < 8; i++) { const zy = byy - 32 + i * 5.5, zx = bx - 27 - i * 1.3; ctx.beginPath(); ctx.moveTo(zx - 3, zy); ctx.lineTo(zx + 3, zy); ctx.stroke(); }
  ctx.restore();
  roundRect(bx - 29, byy - 36, 5, 8, 2, '#bbb'); // zipper pull

  // collar, spring, person, mascot head
  const pop = f.popY;
  const headX = neckX + 4 + clamp(f.popV * -0.01, -6, 6), headY = neckY - 26 - pop;
  if (pop > 2) drawSpring(neckX, neckY - 4, headX - 2, headY + 22);
  drawPerson(L.person, neckX, neckY - 16, f, pop);
  ellipse(neckX, neckY + 1, 21, 7, L.shade);
  const tilt = p.headTilt + (pop > 5 ? Math.sin(game.t * 9) * Math.min(0.35, pop * 0.004) + f.popV * 0.0006 : 0);
  drawMascotHead(L, headX, headY, f, tilt);

  // front arm + glove
  const fg = g(p.front);
  ctx.strokeStyle = L.body; ctx.lineWidth = 13;
  ctx.beginPath(); ctx.moveTo(bx + 14, byy - 18); ctx.lineTo(fg.x, fg.y); ctx.stroke();
  drawGlove(fg.x, fg.y, L.glove);
  ctx.restore();
  ctx.filter = 'none';

  // dizzy stars around the exposed person
  if (f.state === 'down' || f.state === 'ko') {
    const sx = f.x + f.facing * (neckX + 4), sy = GROUND + neckY - 50;
    for (let i = 0; i < 3; i++) {
      const a = game.t * 4 + i * 2.09;
      text('★', sx + Math.cos(a) * 24, sy + Math.sin(a) * 6, 14, '#ffe066', 'center', '#7a5a00');
    }
  }
  if (f.special >= 100 && game.state === 'fight') {
    ctx.globalAlpha = 0.25 + Math.sin(game.t * 10) * 0.15;
    ellipse(f.x, GROUND - 95, 72, 110, '#ffd54f');
    ctx.globalAlpha = 1;
  }
}

function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt, 0, 255), g = clamp(((n >> 8) & 255) + amt, 0, 255), b = clamp((n & 255) + amt, 0, 255);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.min(1, p.life / (p.max * 0.4));
    if (p.kind === 'feather') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ellipse(0, 0, p.size, p.size * 0.35, p.color);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-p.size, 0); ctx.lineTo(p.size, 0); ctx.stroke();
      ctx.restore();
    } else circle(p.x, p.y, p.size, p.color);
  }
  ctx.globalAlpha = 1;
  for (const p of popups) {
    const k = p.t / 0.9;
    ctx.globalAlpha = 1 - k * k;
    text(p.text, p.x, p.y - easeOut(Math.min(1, k * 2)) * 40, p.size * (k < 0.1 ? 0.6 + k * 4 : 1), p.color);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- HUD
function drawHUD() {
  const [p1, p2] = game.fighters;
  drawBar(p1, compact ? 12 : 24, false);
  drawBar(p2, W - (compact ? 12 : 24), true);
  // timer
  const tw = compact ? 72 : 92;
  roundRect(W / 2 - tw / 2, 12, tw, 62, 10, '#111c', '#e8c15a', 3);
  text(String(Math.ceil(game.timer)), W / 2, 40, 34, game.timer < 10 ? '#ff6b6b' : '#fff');
  text((compact ? 'RND ' : 'ROUND ') + game.round, W / 2, 65, 12, '#e8c15a', 'center', null, 700);
}
function drawBar(f, x, right) {
  const w = compact ? W / 2 - 60 : 330, dir = right ? -1 : 1, x0 = right ? x - w : x;
  const name = compact ? f.look.name.replace(' BRUISER', '') : f.look.name;
  text(name, x + dir * 4, 22, compact ? 18 : 20, '#fff', right ? 'right' : 'left');
  if (!compact) text(game.playerLabel(f), x + dir * (ctx.measureText(name).width + 16), 23, 12, '#e8c15a', right ? 'right' : 'left', null, 700);
  // round wins as eggs
  for (let i = 0; i < WINS_NEEDED; i++) {
    const ex = x + dir * (w - 10 - i * 22);
    ellipse(ex, 22, 8, 10, i < f.wins ? '#fff3c4' : '#0006');
    ctx.strokeStyle = '#e8c15a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(ex, 22, 8, 10, 0, 0, 7); ctx.stroke();
  }
  // health
  roundRect(x0 - 3, 37, w + 6, 24, 6, '#111c');
  const hw = w * f.hp / 100, dw = w * f.dispHp / 100;
  ctx.fillStyle = '#ffeb3b'; ctx.fillRect(right ? x - dw : x, 40, dw, 18);
  const hg = ctx.createLinearGradient(0, 40, 0, 58);
  const low = f.hp < 30;
  hg.addColorStop(0, low ? '#ff7b7b' : '#7ee07e'); hg.addColorStop(1, low ? '#c62828' : '#2e9b3a');
  ctx.fillStyle = hg; ctx.fillRect(right ? x - hw : x, 40, hw, 18);
  // stamina + special
  const sw0 = compact ? w : w * 0.7;
  roundRect(x0 - 3, 64, sw0 + 6, 10, 4, '#111c');
  ctx.fillStyle = f.stamina < 20 ? '#ff9800' : '#4fc3f7';
  const sw = sw0 * f.stamina / 100;
  ctx.fillRect(right ? x - sw : x, 66, sw, 6);
  const mw = sw0 * f.special / 100;
  roundRect(x0 - 3, 77, sw0 + 6, 12, 4, '#111c');
  ctx.fillStyle = f.special >= 100 ? (Math.sin(game.t * 12) > 0 ? '#ffd54f' : '#ff8f00') : '#c49a1c';
  ctx.fillRect(right ? x - mw : x, 79, mw, 8);
  if (compact) {
    if (f.special >= 100) text('SPECIAL READY!', x + dir * 4, 100, 12, '#ffd54f', right ? 'right' : 'left', '#000', 800);
    for (let i = 0; i < f.knockdowns; i++) text('✖', x + dir * (w - 8 - i * 16), 100, 13, '#ff5252', 'center', '#000', 700);
  } else {
    text(f.special >= 100 ? 'SPECIAL READY!' : 'SPECIAL', x + dir * (w * 0.7 + 12), 83, 11, f.special >= 100 ? '#ffd54f' : '#c9b37a', right ? 'right' : 'left', '#000', 700);
    for (let i = 0; i < f.knockdowns; i++) text('✖', x + dir * (w * 0.7 + 18 + i * 16), 68, 13, '#ff5252', 'center', '#000', 700);
  }
}

function drawCenterBanner(big, small, color = '#ffe066') {
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, H / 2 - 80, W, small ? 150 : 120);
  text(big, W / 2, H / 2 - 22, fz(72), color, 'center', '#3a0606');
  if (small) text(small, W / 2, H / 2 + 40, fz(24), '#fff');
}

// draw something in world (ring) coordinates, scrolled by the camera
function inWorld(camX, fn) {
  ctx.save(); ctx.translate(-Math.round(camX), 0); fn(); ctx.restore();
}

// ---------------------------------------------------------------- screens
function drawTitle() {
  const [a, b] = game.titleFighters;
  a.x = compact ? 270 : 200; b.x = compact ? 690 : 760; a.facing = 1; b.facing = -1;
  a.state = b.state = 'idle';
  inWorld((WW - W) / 2, () => { drawBackground(); drawFrontRopes(); drawFighter(a); drawFighter(b); drawParticles(); });
  ctx.fillStyle = 'rgba(10,5,2,0.55)'; ctx.fillRect(0, 0, W, H);
  const bounce = Math.sin(game.t * 3) * 4;
  text('COOP', W / 2, 92 + bounce, fz(92), '#fff3c4', 'center', '#5a1006');
  text('KNOCKOUT', W / 2, (compact ? 160 : 172) + bounce, fz(92), '#ff5a3c', 'center', '#3a0606');
  text('~ mascot boxing: knock their block off! ~', W / 2, 228, fz(18) + (compact ? 2 : 0), '#e8c15a', 'center', null, 700);
  MENU.forEach((m, i) => {
    const r = menuRect(i), sel = i === game.menuIndex;
    roundRect(r.x, r.y, r.w, r.h, 10, sel ? '#b3261e' : '#000a', sel ? '#ffe08a' : '#ffffff40', sel ? 3 : 2);
    text(m.label(), W / 2, r.y + r.h / 2 + 1, 22, sel ? '#fff' : '#ddd', 'center', null, 800);
  });
  let lines;
  if (isTouch) lines = ['Tap to choose · fight with the on-screen buttons', 'Turn your phone sideways for the full ring'];
  else if (compact) lines = ['P1: A/D move · S block · W dodge · F/G/H punch', 'P2: ←/→ · ↓ block · ↑ dodge · J/K/L punch'];
  else lines = ['P1: A/D move · S block · W dodge · F jab · G hook · H special      P2: ←/→ · ↓ block · ↑ dodge · J jab · K hook · L special',
    'Solo play: either key set works · Space = dodge · P = pause · M = mute'];
  if (isTouch && !compact) lines = [lines[0]];
  const bh = 14 + lines.length * 18;
  ctx.fillStyle = '#000a'; ctx.fillRect(0, H - bh, W, bh);
  lines.forEach((l, i) => text(l, W / 2, H - bh + 16 + i * 18, compact ? 14 : 13, i ? '#aaa' : '#ddd', 'center', null, 600));
}

function draw() {
  ctx.setTransform(backing, 0, 0, backing, 0, 0);
  ctx.save();
  if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));
  if (game.state === 'title') { drawTitle(); ctx.restore(); return; }
  if (game.state === 'select') { drawSelect(); inWorld((WW - W) / 2, drawParticles); ctx.restore(); return; }

  inWorld(game.camX || 0, () => {
    drawBackground();
    const fs = [...game.fighters].sort((a, b) => (a.state === 'attack') - (b.state === 'attack'));
    const refFront = game.state === 'entrance';
    if (!refFront) drawReferee();
    fs.forEach(drawFighter);
    if (refFront) drawReferee();
    drawParticles();
    drawFrontRopes();
  });
  if (game.state !== 'entrance' && game.state !== 'matchEnd') drawHUD();

  if (flashScreen > 0) { ctx.fillStyle = `rgba(255,255,255,${flashScreen * 0.5})`; ctx.fillRect(-20, -20, W + 40, H + 40); }

  switch (game.state) {
    case 'intro':
      if (game.t < 1.3) drawCenterBanner('ROUND ' + game.round, game.round === 1 ? `${game.fighters[0].look.name}  vs  ${game.fighters[1].look.name}` : null);
      else drawCenterBanner('FIGHT!', null, '#ff5a3c');
      break;
    case 'knockdown': {
      const f = game.downed;
      if (game.t > 1 && f.knockdowns < 3) {
        text(String(Math.max(1, game.count)), W / 2, 160, 100, '#fff', 'center', '#3a0606');
        const human = game.mode === 2 || f.side === 0;
        if (human) {
          text(isTouch ? 'TAP PUNCHES TO PUT YOUR HEAD BACK ON!' : compact ? 'MASH PUNCH TO PUT YOUR HEAD ON!' : 'MASH PUNCH KEYS TO PUT YOUR HEAD BACK ON!', W / 2, 228, fz(24), '#ffe066');
          roundRect(W / 2 - 150, 246, 300, 18, 8, '#000a', '#fff8');
          roundRect(W / 2 - 148, 248, 296 * Math.min(1, f.getupProgress / game.need), 14, 6, '#7ee07e');
        }
      } else if (f.knockdowns >= 3 && game.t > 1) text('THREE KNOCKDOWNS!', W / 2, 160, fz(48), '#ff5252');
      break;
    }
    case 'roundEnd':
      drawCenterBanner(game.msg, game.subMsg, game.msg.startsWith('TIME') ? '#ffe066' : '#ff5a3c');
      break;
    case 'entrance': drawEntranceOverlay(); break;
    case 'matchEnd': {
      const w = game.winner, ct = game.ceremonyT;
      if (game.t > 0.4) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 34, W, 140);
        if (!w) text("IT'S A DRAW!", W / 2, 100, fz(64), '#ffe066', 'center', '#3a0606');
        else if (ct < 1.1) text('AND THE WINNER IS...', W / 2, 100, fz(48), '#fff', 'center', '#3a0606');
        else {
          const pop = easeOut(Math.min(1, (ct - 1.1) * 4));
          text(w.look.name + '!', W / 2, 88, fz(64) * (0.6 + 0.4 * pop), '#ffe066', 'center', '#3a0606');
          const sub = game.mode === 1 ? (w.side === 0 ? 'You are the Champion of the Coop! 🏆' : 'You got plucked. Try again!') : `${game.playerLabel(w)} rules the roost!`;
          text(sub, W / 2, 144, fz(24), '#fff');
        }
      }
      if (ct > 2.2) {
        const [rb, mb] = twoButtons(H - 62);
        drawButton(rb, isTouch ? 'REMATCH' : 'REMATCH (R)', true);
        drawButton(mb, isTouch ? 'MENU' : 'MENU (Enter)', false);
      }
      break;
    }
    case 'paused': {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H);
      text('PAUSED', W / 2, H / 2 - 30, fz(72), '#fff');
      const [rb, qb] = twoButtons(H / 2 + 60);
      drawButton(rb, isTouch ? 'RESUME' : 'RESUME (P)', true);
      drawButton(qb, isTouch ? 'QUIT' : 'QUIT (Q)', false);
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  update(dt);
  syncPlaying();
  draw();
  pressed.clear();
  clickPos = null;
  requestAnimationFrame(frame);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

// exposed for debugging / automated tests
window.__coop = { game, keys, pressed, Fighter, ATK };
})();
