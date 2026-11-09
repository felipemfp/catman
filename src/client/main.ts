import * as Phaser from 'phaser';
import { config } from '../core/index.ts';
import { GameScene, CAUSE_TEXT, newSeed } from './scene.ts';
import { parseBoot, searchFor } from './url.ts';
import { formatScore } from './format.ts';

const boot = parseBoot(location.search, newSeed);
if (boot.seedReplaced) history.replaceState(null, '', searchFor(boot.seed, boot.ghostId));

const scene = new GameScene();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#14121c',
  width: config.world.widthU,
  height: config.world.heightU,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [],
  banner: false,
});
game.scene.add('game', scene, true, { seed: boot.seed, ghostId: boot.ghostId });

// ---- DOM menus over the canvas (real buttons: keyboard and screen-reader friendly) ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $('title');
const death = $('death');
const seedEl = $('seed');
const ghostEl = $('ghost');
const scoreEl = $('score');
const causeEl = $('cause');
const vsEl = $('vs');
const linkEl = $<HTMLInputElement>('link');
const errEl = $('error');
const copySeedBtn = $<HTMLButtonElement>('btn-copy-seed');
const muteBtn = $<HTMLButtonElement>('btn-mute');
const viewBtn = $<HTMLButtonElement>('btn-view');

function render(): void {
  const ui = scene.ui();
  title.hidden = ui.screen !== 'title';
  death.hidden = ui.screen !== 'death';
  seedEl.textContent = `seed ${scene.seed}`;
  ghostEl.textContent = `ghost: ${ui.ghostLine}`;
  muteBtn.textContent = scene.sfx.isMuted() ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-label', scene.sfx.isMuted() ? 'Unmute' : 'Mute');
  // the button names the view it switches to
  viewBtn.textContent = scene.cam.view === 'flat' ? '2.5D' : 'Top';
  viewBtn.setAttribute('aria-label', scene.cam.view === 'flat' ? 'Switch to 2.5D view' : 'Switch to top-down view');
  if (ui.screen === 'death' && scene.ended) {
    scoreEl.textContent = formatScore(scene.ended.score);
    causeEl.textContent = CAUSE_TEXT[scene.ended.cause];
    const gh = scene.ghost;
    vsEl.textContent = gh
      ? scene.ended.score > gh.finalScore ? `You beat the ghost by ${formatScore(scene.ended.score - gh.finalScore)}`
        : scene.ended.score === gh.finalScore ? 'Tied with the ghost' : `Ghost wins by ${formatScore(gh.finalScore - scene.ended.score)}`
      : '';
  }
  linkEl.hidden = ui.shareLink === null;
  linkEl.value = ui.shareLink ?? '';
  errEl.hidden = ui.errorText === null;
  errEl.textContent = ui.errorText ?? '';
  copySeedBtn.hidden = ui.errorText === null;
}
scene.onUi = render;

$('btn-play').addEventListener('click', () => { scene.sfx.unlock(); scene.startRun(); });
$('btn-again').addEventListener('click', () => scene.startRun());
$('btn-new').addEventListener('click', () => scene.newSeed());
$('btn-share').addEventListener('click', () => { void scene.share(); });
copySeedBtn.addEventListener('click', () => { void navigator.clipboard?.writeText(linkEl.value).catch(() => {}); linkEl.select(); });
linkEl.addEventListener('focus', () => linkEl.select());
muteBtn.addEventListener('click', () => scene.toggleMute());
viewBtn.addEventListener('click', () => { scene.toggleView(); viewBtn.blur(); });
render();

if (import.meta.env.MODE !== 'production') {
  void import('./dev-hooks.ts').then((m) => m.installHooks(scene));
}
