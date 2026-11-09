// The one Phaser scene. All rules live in core: this file only samples input, calls step(), and draws view().
import * as Phaser from 'phaser';
import {
  CORE_VERSION, bossHpFor, catTopY, config, createRecorder, createRun, hashState, simulateBossFight, step, toBase64,
  validateGhostPayload, view, type CoreEvent, type DeepReadonly, type EndCause, type GatePair, type InputLevel, type Run,
  type RunState, type WeaponId,
} from '../core/index.ts';
import { advance, TICK_MS } from './loop.ts';
import { levelFromKeys, levelFromPointer } from './input.ts';
import { gateLabel } from './labels.ts';
import { formatScore } from './format.ts';
import { createGhostCheck, ghostScoreAt, type GhostTrack } from './ghostcheck.ts';
import { fetchGhost, verifyBody } from './ghostfetch.ts';
import { searchFor, seedFromBytes, shareLink } from './url.ts';
import { createSfx } from './sfx.ts';

const W = config.world.widthU;
const H = config.world.heightU;
const CAT_Y = config.world.catLineY;
const COL = {
  bg: 0x14121c, lane: 0x1d1a29, cat: 0xf4ead5, ghost: 0x8fd3ff, rat: 0xb9a99a, ratEye: 0xff5a5a, boss: 0xd8c3ad, crown: 0xffd23f,
  pencil: 0xffd23f, laser: 0x4ff2ff, yarn: 0xff5577, fish: 0xc8ccd4, buff: 0x2fbf71, debuff: 0xe0464b, weapon: 0x7a5cff, text: '#f4ead5',
  tuna: 0x5b8def, tunaBelly: 0xd6e4ff, tunaGlow: 0x2fbf71,
};
const MY_GHOSTS = 'catman.myGhosts';

export type Screen = 'title' | 'run' | 'death';
export type UiState = { screen: Screen; deathScore: number | null; shareLink: string | null; errorText: string | null; ghostLine: string };
type Ended = { cause: EndCause; score: number; tick: number };
type Scripted = { levels: readonly InputLevel[]; i: number; resolve: (r: { hash: string; ended: Ended | null }) => void };

type DamageNum = { text: Phaser.GameObjects.Text; life: number; vy: number };
type Puff = { x: number; y: number; life: number; live: boolean };

function readMyGhosts(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(MY_GHOSTS) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function addMyGhost(id: string): void {
  try {
    localStorage.setItem(MY_GHOSTS, JSON.stringify([...readMyGhosts(), id].slice(-50)));
  } catch { /* storage unavailable */ }
}

function newSeed(): string {
  return seedFromBytes(() => crypto.getRandomValues(new Uint8Array(16)));
}

const CAUSE_TEXT: Record<EndCause, string> = { rats: 'Overrun by rats', boss: 'The boss reached you', timeout: 'Time up' };

export class GameScene extends Phaser.Scene {
  seed = '';
  screen: Screen = 'title';
  run: Run | null = null;
  recorder = createRecorder();
  acc = 0;
  ended: Ended | null = null;
  scripted: Scripted | null = null;
  // ghost
  ghostId: string | null = null;
  ghostStatus = 'none';
  ghostCheck: ReturnType<typeof createGhostCheck> | null = null;
  ghostReady: GhostTrack | null = null; // verified, attaches on the next Play/Again
  ghost: GhostTrack | null = null; // attached to the current run
  ghostFetchToken = 0;
  // share
  shareLinkText: string | null = null;
  errorText: string | null = null;
  // input
  keys = { left: false, right: false };
  pointerDown = false;
  pointerX = W / 2;
  lastDevice: 'keys' | 'pointer' = 'keys';
  // render
  g!: Phaser.GameObjects.Graphics;
  hud!: Phaser.GameObjects.Text;
  hudRight!: Phaser.GameObjects.Text;
  warnText!: Phaser.GameObjects.Text;
  warnUntil = 0;
  gateTexts: Phaser.GameObjects.Text[] = [];
  damageNums: DamageNum[] = [];
  puffs: Puff[] = [];
  dpsKey = '';
  dpsText = '';
  reducedMotion = false;
  sfx = createSfx();
  frame = 0;
  onUi: (() => void) | null = null;

  constructor() {
    super('game');
  }

  init(data: { seed: string; ghostId: string | null }): void {
    this.seed = data.seed;
    this.ghostId = data.ghostId;
  }

  create(): void {
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.g = this.add.graphics();
    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '22px', color: COL.text };
    this.hud = this.add.text(12, 10, '', style).setDepth(10);
    this.hudRight = this.add.text(W - 12, 10, '', { ...style, align: 'right' }).setOrigin(1, 0).setDepth(10);
    this.warnText = this.add.text(W / 2, 120, '', { ...style, fontSize: '24px', fontStyle: 'bold', align: 'center', backgroundColor: '#000000aa', padding: { x: 10, y: 8 } })
      .setOrigin(0.5, 0).setDepth(11).setVisible(false);
    // pools allocated once, up front: nothing pooled is created per frame (C8)
    for (let i = 0; i < 40; i++) {
      const text = this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '16px', color: '#ffe08a', fontStyle: 'bold' }).setOrigin(0.5).setDepth(5).setVisible(false);
      this.damageNums.push({ text, life: 0, vy: 0 });
      this.puffs.push({ x: 0, y: 0, life: 0, live: false });
    }
    for (let i = 0; i < 8; i++) {
      this.gateTexts.push(this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#ffffff', align: 'center' }).setOrigin(0.5).setDepth(4).setVisible(false));
    }
    this.setupInput();
    if (this.ghostId) this.startGhostFetch(this.ghostId);
    this.setScreen('title');
  }

  // ---------------- input ----------------
  setupInput(): void {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { this.keys.left = down; this.lastDevice = 'keys'; e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { this.keys.right = down; this.lastDevice = 'keys'; e.preventDefault(); }
      else if (down && (k === 'm' || k === 'M')) this.toggleMute();
      if (down) this.sfx.unlock();
    };
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    window.addEventListener('blur', () => { this.keys.left = false; this.keys.right = false; this.pointerDown = false; });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { this.pointerDown = true; this.pointerX = p.worldX; this.lastDevice = 'pointer'; this.sfx.unlock(); });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { this.pointerX = p.worldX; });
    this.input.on('pointerup', () => { this.pointerDown = false; });
    this.input.on('pointerupoutside', () => { this.pointerDown = false; });
  }

  toggleMute(): void {
    this.sfx.toggle();
    this.onUi?.();
  }

  sampleInput(v: DeepReadonly<RunState>): InputLevel {
    if (this.lastDevice === 'pointer') return this.pointerDown ? levelFromPointer(this.pointerX, v.cat.x) : 0;
    return levelFromKeys(this.keys.left, this.keys.right);
  }

  // ---------------- screens ----------------
  setScreen(s: Screen): void {
    this.screen = s;
    this.hud.setVisible(s === 'run');
    this.hudRight.setVisible(s === 'run');
    if (s !== 'run') this.warnText.setVisible(false);
    this.onUi?.();
  }

  ghostLine(): string {
    return this.ghostStatus;
  }

  ui(): UiState {
    return {
      screen: this.screen,
      deathScore: this.screen === 'death' && this.ended ? this.ended.score : null,
      shareLink: this.shareLinkText,
      errorText: this.errorText,
      ghostLine: this.ghostLine(),
    };
  }

  /** Play / Again: a fresh run on the current seed, attaching a verified ghost if there is one. */
  startRun(): void {
    this.run = createRun(this.seed);
    this.recorder = createRecorder();
    this.acc = 0;
    this.ended = null;
    this.shareLinkText = null;
    this.errorText = null;
    this.ghost = this.ghostReady;
    if (this.ghost) this.ghostStatus = `ready: ${formatScore(this.ghost.finalScore)} to beat`;
    this.dpsKey = '';
    for (const d of this.damageNums) { d.life = 0; d.text.setVisible(false); }
    for (const p of this.puffs) p.live = false;
    this.setScreen('run');
  }

  newSeed(): void {
    this.seed = newSeed();
    this.ghostId = null;
    this.ghostReady = null;
    this.ghost = null;
    this.ghostCheck = null;
    this.ghostFetchToken++;
    this.ghostStatus = 'none';
    history.replaceState(null, '', searchFor(this.seed, null));
    this.setScreen('title');
  }

  // ---------------- ghost ----------------
  startGhostFetch(id: string): void {
    const token = ++this.ghostFetchToken;
    this.ghostStatus = 'loading…';
    this.onUi?.();
    const own = readMyGhosts().includes(id);
    void fetchGhost(id, own, {
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }).then((out) => {
      if (token !== this.ghostFetchToken) return;
      if (out.kind === 'unavailable') { this.ghostStatus = 'unavailable'; this.onUi?.(); return; }
      const v = verifyBody(out.body, this.seed);
      if (v.kind !== 'ok') { this.ghostStatus = v.kind; this.onUi?.(); return; }
      this.ghostStatus = 'checking…';
      this.ghostCheck = createGhostCheck(v.payload, v.levels);
      this.onUi?.();
    });
  }

  tickGhostCheck(): void {
    const c = this.ghostCheck;
    if (!c) return;
    const r = c.advance(2000);
    if (!r.done) return;
    this.ghostCheck = null;
    if (r.verdict !== 'ok') { this.ghostStatus = "doesn't match"; this.onUi?.(); return; }
    this.ghostReady = c.track();
    this.ghostStatus = this.screen === 'title'
      ? `ready: ${formatScore(this.ghostReady.finalScore)} to beat`
      : 'ready (next run)';
    this.onUi?.();
  }

  // ---------------- share ----------------
  async share(): Promise<void> {
    if (!this.ended) return;
    const seedOnly = shareLink(location.origin, this.seed);
    const payload = { v: 1 as const, coreVersion: CORE_VERSION, seed: this.seed, score: this.ended.score, ticks: this.recorder.ticks(), inputs: toBase64(this.recorder.bytes()) };
    const check = validateGhostPayload(payload);
    if (!check.ok) {
      this.errorText = check.code === 'inputs_too_large' ? 'This run is too long to share as a ghost' : `This run can't be shared as a ghost (${check.code})`;
      this.shareLinkText = seedOnly;
      this.onUi?.();
      return;
    }
    this.errorText = null;
    this.onUi?.();
    let res: Response;
    try {
      res = await fetch('/api/ghost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch {
      this.errorText = "Couldn't reach the server to share the ghost.";
      this.shareLinkText = seedOnly;
      this.onUi?.();
      return;
    }
    if (res.status !== 201) {
      const why = res.status === 429 ? 'Too many shares in a minute' : `Server said ${res.status}`;
      this.errorText = `${why}; the ghost wasn't saved.`;
      this.shareLinkText = seedOnly;
      this.onUi?.();
      return;
    }
    const { id } = (await res.json()) as { id: string };
    addMyGhost(id);
    const link = shareLink(location.origin, this.seed, id);
    this.shareLinkText = link;
    this.onUi?.();
    try {
      if (typeof navigator.share === 'function') await navigator.share({ title: 'Catman', text: `Beat my ${formatScore(this.ended.score)} in Catman`, url: link });
      else await navigator.clipboard.writeText(link);
    } catch { /* user cancelled or clipboard blocked: the link is shown anyway */ }
  }

  // ---------------- hooks ----------------
  startScripted(levels: readonly InputLevel[]): Promise<{ hash: string; ended: Ended | null }> {
    return new Promise((resolve) => {
      this.startRun();
      this.scripted = { levels, i: 0, resolve };
    });
  }

  // ---------------- frame ----------------
  override update(_time: number, deltaMs: number): void {
    this.frame++;
    this.tickGhostCheck();
    if (this.screen === 'run' && this.run) {
      const delta = this.scripted ? 5 * TICK_MS : deltaMs;
      const a = advance(this.acc, delta, !this.scripted && document.hidden);
      this.acc = a.accMs;
      for (let i = 0; i < a.steps; i++) {
        const run = this.run;
        let level: InputLevel;
        if (this.scripted) {
          const pl = this.scripted;
          if (pl.i >= pl.levels.length) { this.finishScripted(); break; }
          level = pl.levels[pl.i++]!;
        } else level = this.sampleInput(view(run));
        const ev = step(run, level);
        this.recorder.push(level);
        this.juice(ev);
        const e = ev.find((x) => x.t === 'ended');
        if (e && e.t === 'ended') {
          this.ended = { cause: e.cause, score: e.score, tick: e.tick };
          if (this.scripted) this.finishScripted();
          break;
        }
      }
      if (this.scripted && this.scripted.i >= this.scripted.levels.length && !this.ended) this.finishScripted();
    }
    this.updateJuice(deltaMs);
    this.draw();
    if (this.ended && this.screen === 'run') {
      this.sfx.play('death');
      this.setScreen('death');
    }
  }

  finishScripted(): void {
    const pl = this.scripted;
    if (!pl || !this.run) return;
    this.scripted = null;
    pl.resolve({ hash: hashState(this.run), ended: this.ended });
  }

  // ---------------- juice ----------------
  juice(ev: CoreEvent[]): void {
    for (const e of ev) {
      switch (e.t) {
        case 'damage': this.spawnDamage(e.x, e.y, e.amount); break;
        case 'ratKilled': this.spawnPuff(e.x, e.y); break;
        case 'catHit':
          this.sfx.play('hit');
          if (!this.reducedMotion) { this.cameras.main.shake(120, 4 / W); this.cameras.main.flash(80, 255, 255, 255); }
          break;
        case 'bossKilled':
          if (!this.reducedMotion) this.cameras.main.shake(300, 10 / W);
          break;
        case 'gateTaken': this.sfx.play('gate'); break;
        case 'tunaEaten':
          this.sfx.play('heal');
          if (this.run) this.spawnText(view(this.run).cat.x, CAT_Y - 40, e.healed ? '+1 ♥' : `+${config.tuna.fullHpScore}`);
          break;
        case 'bossWarning': {
          this.sfx.play('warning');
          const verdict = e.onPace ? 'ON PACE' : 'TOO WEAK';
          this.warnText.setText(`BOSS · YOU ${Math.round(e.haveDps)}/s · NEED ${Math.round(e.needDps)}/s\n${verdict}`);
          this.warnText.setBackgroundColor(e.onPace ? '#1f6f45' : '#8a2327');
          this.warnText.setVisible(true);
          this.warnUntil = this.frame + 60 * 5;
          break;
        }
        case 'bossSpawned': this.warnUntil = Math.min(this.warnUntil, this.frame + 90); break;
        default: break;
      }
    }
  }

  spawnDamage(x: number, y: number, amount: number): void {
    this.spawnText(x, y, String(Math.round(amount)));
  }

  spawnText(x: number, y: number, s: string): void {
    const d = this.damageNums.find((n) => n.life <= 0);
    if (!d) return; // pool full: drop the number
    d.life = 400;
    d.vy = -0.06;
    d.text.setText(s).setPosition(x, y).setVisible(true).setAlpha(1);
  }

  spawnPuff(x: number, y: number): void {
    const p = this.puffs.find((q) => !q.live);
    if (!p) return;
    p.x = x; p.y = y; p.life = 250; p.live = true;
  }

  updateJuice(dt: number): void {
    for (const d of this.damageNums) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.text.y += d.vy * dt;
      d.text.setAlpha(Math.max(0, d.life / 400));
      if (d.life <= 0) d.text.setVisible(false);
    }
    for (const p of this.puffs) if (p.live) { p.life -= dt; if (p.life <= 0) p.live = false; }
    if (this.warnText.visible && this.frame > this.warnUntil) this.warnText.setVisible(false);
  }

  poolStats(): Record<string, { live: number; allocated: number }> {
    return {
      damageNumbers: { live: this.damageNums.filter((d) => d.life > 0).length, allocated: this.damageNums.length },
      puffs: { live: this.puffs.filter((p) => p.live).length, allocated: this.puffs.length },
      gateLabels: { live: this.gateTexts.filter((t) => t.visible).length, allocated: this.gateTexts.length },
    };
  }

  // ---------------- drawing ----------------
  draw(): void {
    const g = this.g;
    g.clear();
    g.fillStyle(COL.bg, 1).fillRect(0, 0, W, H);
    if (!this.run || this.screen === 'title') {
      for (const t of this.gateTexts) t.setVisible(false);
      this.drawCat(g, W / 2, CAT_Y, COL.cat, 1, 0);
      return;
    }
    const v = view(this.run);
    // lane stripes scroll with distance
    g.fillStyle(COL.lane, 1);
    const off = v.distanceU % 120;
    for (let y = -120 + off; y < H; y += 120) g.fillRect(0, y, W, 60);
    this.drawGates(g, v);
    for (const t of v.tunas) this.drawTuna(g, t.x, t.y);
    for (const r of v.rats) this.drawRat(g, r.x, r.y, 1);
    if (v.boss) this.drawBoss(g, v.boss.x, v.boss.y, v.boss.hp / v.boss.maxHp);
    this.drawShots(g, v);
    for (const p of this.puffs) {
      if (!p.live) continue;
      const k = 1 - p.life / 250;
      g.lineStyle(2, 0xffffff, 1 - k).strokeCircle(p.x, p.y, 8 + 18 * k);
    }
    if (this.ghost) {
      const t = this.ghost;
      const i = Math.min(v.tick, t.ticks) - 1;
      const gx = i >= 0 ? t.xs[i]! : W / 2;
      this.drawCat(g, gx, CAT_Y, COL.ghost, 0.45, 0);
    }
    const blink = v.cat.invulnTicks > 0 && Math.floor(v.cat.invulnTicks / 4) % 2 === 0;
    this.drawCat(g, v.cat.x, CAT_Y, COL.cat, blink ? 0.35 : 1, v.cat.vx);
    this.drawHud(v);
  }

  drawHud(v: DeepReadonly<RunState>): void {
    const hearts = '♥'.repeat(Math.max(0, v.cat.hp)) + '♡'.repeat(Math.max(0, config.cat.hp - v.cat.hp));
    const key = `${v.cat.weapon}|${v.bossesSpawned}|${JSON.stringify(v.cat.mods)}`;
    if (key !== this.dpsKey) {
      this.dpsKey = key;
      const r = simulateBossFight({ ...v.cat.mods }, v.cat.weapon, bossHpFor(v.bossesSpawned), W / 2);
      this.dpsText = `${Math.round(r.damageByReach / (r.reachTick / 60))}/s`;
    }
    let ghostLine = '';
    if (this.ghost) {
      const delta = v.score - ghostScoreAt(this.ghost, v.tick);
      ghostLine = `\nvs ghost ${delta >= 0 ? '+' : '−'}${formatScore(Math.abs(delta))}`;
    }
    this.hud.setText(`${formatScore(v.score)}\n${hearts}${ghostLine}`);
    this.hudRight.setText(`${weaponName(v.cat.weapon)}\nDPS ${this.dpsText}\n${Math.floor(v.distanceU / 10)} m`);
  }

  drawGates(g: Phaser.GameObjects.Graphics, v: DeepReadonly<RunState>): void {
    let ti = 0;
    const gh = config.gates.heightU;
    for (const pair of v.gates as readonly DeepReadonly<GatePair>[]) {
      if (pair.y < -gh || pair.y > H + gh) continue;
      for (const side of ['left', 'right'] as const) {
        const gate = side === 'left' ? pair.left : pair.right;
        const x0 = side === 'left' ? 0 : W / 2;
        const label = gateLabel(gate as GatePair['left'], v.cat.weapon);
        const isWeapon = gate.kind === 'weapon' && gate.weapon !== v.cat.weapon;
        const alpha = pair.resolved ? 0.25 : 0.55;
        g.fillStyle(isWeapon ? COL.weapon : COL.lane, alpha).fillRect(x0 + 4, pair.y - gh, W / 2 - 8, gh * 2);
        // buff stripe on top (green), debuff below (red): extra to the icons and signs
        if (!isWeapon) {
          g.fillStyle(COL.buff, alpha + 0.2).fillRect(x0 + 4, pair.y - gh, W / 2 - 8, 6);
          g.fillStyle(COL.debuff, alpha + 0.2).fillRect(x0 + 4, pair.y + gh - 6, W / 2 - 8, 6);
        }
        g.lineStyle(3, 0xffffff, pair.resolved ? 0.2 : 0.8).strokeRect(x0 + 4, pair.y - gh, W / 2 - 8, gh * 2);
        const t = this.gateTexts[ti];
        if (!t) continue;
        ti++;
        const icon = label.icons.map(iconGlyph).join(' ');
        t.setText(`${icon}\n${label.text}`).setPosition(x0 + W / 4, pair.y).setVisible(true).setAlpha(pair.resolved ? 0.35 : 1);
      }
    }
    for (; ti < this.gateTexts.length; ti++) this.gateTexts[ti]!.setVisible(false);
  }

  drawShots(g: Phaser.GameObjects.Graphics, v: DeepReadonly<RunState>): void {
    const cat = v.cat;
    if (cat.weapon === 'laser') {
      const lw = config.weapons.laser;
      const n = Math.max(1, Math.min(9, lw.beams + cat.mods.projectilesAdd));
      const reach = Math.min(lw.rangeU * cat.mods.rangeMult, catTopY);
      const flicker = 0.55 + 0.25 * ((this.frame >> 1) % 2);
      for (let b = 0; b < n; b++) {
        const bx = cat.x + (b - (n - 1) / 2) * lw.beamSpacingU;
        g.fillStyle(COL.laser, flicker * 0.5).fillRect(bx - lw.beamWidthU / 2, catTopY - reach, lw.beamWidthU, reach);
        g.fillStyle(0xffffff, flicker).fillRect(bx - 2, catTopY - reach, 4, reach);
      }
    }
    for (const p of v.projectiles) {
      if (p.weapon === 'pencil') {
        g.fillStyle(COL.pencil, 1).fillRect(p.x - 3, p.y - 8, 6, 13);
        g.fillStyle(0xf2c9a0, 1).fillTriangle(p.x - 3, p.y - 8, p.x + 3, p.y - 8, p.x, p.y - 13);
        g.fillStyle(0xff8fa3, 1).fillRect(p.x - 3, p.y + 5, 6, 3);
      } else if (p.weapon === 'yarn') {
        g.lineStyle(2, COL.yarn, 0.6).lineBetween(p.x, p.y, p.x - p.vx * 3, p.y - p.vy * 3);
        g.fillStyle(COL.yarn, 1).fillCircle(p.x, p.y, 6);
        g.lineStyle(1, 0xffffff, 0.6).strokeCircle(p.x, p.y, 3);
      } else {
        g.lineStyle(2, COL.fish, 1).lineBetween(p.x, p.y - 6, p.x, p.y + 6);
        for (let k = -1; k <= 1; k++) g.lineBetween(p.x - 4, p.y + k * 3, p.x + 4, p.y + k * 3);
        g.fillStyle(COL.fish, 1).fillTriangle(p.x - 4, p.y - 6, p.x + 4, p.y - 6, p.x, p.y - 10);
      }
    }
  }

  drawCat(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number, alpha: number, vx: number): void {
    const lean = Math.max(-1, Math.min(1, vx / 9)) * 5;
    g.lineStyle(3, color, alpha);
    // head with ears
    g.strokeCircle(x + lean, y - 14, 9);
    g.fillStyle(color, alpha);
    g.fillTriangle(x + lean - 8, y - 19, x + lean - 3, y - 23, x + lean - 9, y - 28);
    g.fillTriangle(x + lean + 8, y - 19, x + lean + 3, y - 23, x + lean + 9, y - 28);
    // body, arms, legs
    g.lineBetween(x + lean, y - 5, x, y + 10);
    g.lineBetween(x + lean * 0.6, y, x - 10, y - 6);
    g.lineBetween(x + lean * 0.6, y, x + 10, y - 6);
    g.lineBetween(x, y + 10, x - 8, y + 23);
    g.lineBetween(x, y + 10, x + 8, y + 23);
    // tail
    g.lineBetween(x, y + 9, x + 10 - lean, y + 5);
    g.lineBetween(x + 10 - lean, y + 5, x + 15 - lean, y - 4);
  }

  /** A plump tuna with a soft pulse, so it reads as a pickup, not a threat. */
  drawTuna(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
    const pulse = this.reducedMotion ? 1 : 1 + 0.08 * Math.sin(this.frame / 6);
    const r = (config.tuna.sizeU / 2) * pulse;
    g.fillStyle(COL.tunaGlow, 0.25).fillCircle(x, y, r + 8);
    g.fillStyle(COL.tuna, 1).fillEllipse(x, y, r * 2, r * 1.2);
    g.fillTriangle(x + r * 0.8, y, x + r * 1.5, y - r * 0.6, x + r * 1.5, y + r * 0.6);
    g.fillStyle(COL.tunaBelly, 1).fillEllipse(x - r * 0.1, y + r * 0.2, r * 1.4, r * 0.45);
    g.fillStyle(0x000000, 1).fillCircle(x - r * 0.55, y - r * 0.15, 2);
  }

  drawRat(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number): void {
    g.lineStyle(2.5 * s, COL.rat, 1);
    g.strokeCircle(x, y - 6 * s, 6 * s);
    g.fillStyle(COL.rat, 1).fillCircle(x - 6 * s, y - 12 * s, 3.5 * s).fillCircle(x + 6 * s, y - 12 * s, 3.5 * s);
    g.fillStyle(COL.ratEye, 1).fillCircle(x - 2 * s, y - 7 * s, 1.2 * s).fillCircle(x + 2 * s, y - 7 * s, 1.2 * s);
    g.lineBetween(x, y, x, y + 7 * s);
    g.lineBetween(x, y + 3 * s, x - 7 * s, y + 7 * s);
    g.lineBetween(x, y + 3 * s, x + 7 * s, y + 7 * s);
    g.lineBetween(x, y + 7 * s, x - 5 * s, y + 13 * s);
    g.lineBetween(x, y + 7 * s, x + 5 * s, y + 13 * s);
    g.lineBetween(x, y + 7 * s, x + 9 * s, y + 4 * s);
  }

  drawBoss(g: Phaser.GameObjects.Graphics, x: number, y: number, hpFrac: number): void {
    const s = 4;
    this.drawRat(g, x, y, s);
    g.fillStyle(COL.crown, 1).fillTriangle(x - 18, y - 46, x - 10, y - 66, x - 2, y - 46)
      .fillTriangle(x - 6, y - 46, x, y - 72, x + 6, y - 46).fillTriangle(x + 2, y - 46, x + 10, y - 66, x + 18, y - 46);
    const bw = 120;
    g.fillStyle(0x000000, 0.6).fillRect(x - bw / 2, y - 80, bw, 8);
    g.fillStyle(COL.debuff, 1).fillRect(x - bw / 2, y - 80, bw * Math.max(0, hpFrac), 8);
  }
}

function weaponName(w: WeaponId): string {
  return { pencil: '✏️ Pencil', laser: '🔦 Laser', yarn: '🧶 Yarn', fishbone: '🐟 Fishbone' }[w];
}

function iconGlyph(id: string): string {
  const m: Record<string, string> = {
    damageMult: '💥', fireRateMult: '⏩', rangeMult: '📏', pierceAdd: '🗡️', projectilesAdd: '➕', moveSpeedMult: '👟',
    pencil: '✏️', laser: '🔦', yarn: '🧶', fishbone: '🐟',
  };
  return m[id] ?? '?';
}

export { CAUSE_TEXT, newSeed };
