/**
 * DOM UI: HUD (health/stamina/fury, timer, momentum), drama toasts,
 * letterbox, entrance title cards, VS/FIGHT splashes, debug overlay,
 * match-select menu and results screen.
 */
import { FIGHTERS } from '../sim/fighters';
import { LAYOUTS, THEMES, type LayoutId, type ThemeId } from '../sim/arenaGen';
import { THEME_DEFS } from '../render/arena/themes';
import type { FighterDef, Frame, MatchResult } from '../sim/types';

const $ = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as T;
};

export interface MenuChoice {
  a: string;
  b: string;
  seed: number;
  skipIntro: boolean;
  arena: { theme: ThemeId | 'random'; layout: LayoutId | 'random'; seed: number };
}

const LAYOUT_LABEL: Record<LayoutId, string> = { pit: 'Circular pit', oval: 'Grand oval', cross: 'Crossroads (central pillars)', split: 'Divided (river + bridges)', gauntlet: 'Narrow gauntlet' };

export class UI {
  root: HTMLElement;
  private hud: HTMLElement;
  private bars: { hp: HTMLElement; trail: HTMLElement; st: HTMLElement; fury: HTMLElement; name: HTMLElement; wrap: HTMLElement }[] = [];
  private timer: HTMLElement;
  private mom: HTMLElement;
  private toastEl: HTMLElement;
  private lb: HTMLElement;
  private title: HTMLElement;
  private splash: HTMLElement;
  debugEl: HTMLElement;
  private menu: HTMLElement;
  private results: HTMLElement;
  private hint: HTMLElement;
  private subEl: HTMLElement;
  private subTimer = 0;
  private settingsEl: HTMLElement;
  private trailHp = [1, 1];
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.lb = $(`<div class="letterbox"><div class="lb-top"></div><div class="lb-bot"></div></div>`);
    this.hud = $(`<div class="hud hidden">
      <div class="side left"></div>
      <div class="center"><div class="timer">0</div><div class="mom"><div class="mom-fill"></div><div class="mom-tick"></div></div></div>
      <div class="side right"></div>
    </div>`);
    for (const side of ['left', 'right']) {
      const el = this.hud.querySelector(`.side.${side}`) as HTMLElement;
      el.innerHTML = `<div class="fname"></div><div class="hpbar"><div class="trail"></div><div class="hp"></div></div><div class="stbar"><div class="st"></div></div><div class="furybar"><div class="fury"></div><span>FURY</span></div>`;
      this.bars.push({
        wrap: el,
        name: el.querySelector('.fname')!,
        hp: el.querySelector('.hp')!,
        trail: el.querySelector('.trail')!,
        st: el.querySelector('.st')!,
        fury: el.querySelector('.fury')!,
      });
    }
    this.timer = this.hud.querySelector('.timer')!;
    this.mom = this.hud.querySelector('.mom-fill')!;
    this.toastEl = $(`<div class="toast"><div class="t-main"></div><div class="t-sub"></div></div>`);
    this.title = $(`<div class="titlecard"><div class="tc-epi"></div><div class="tc-name"></div><div class="tc-bio"></div><div class="tc-grudge"></div></div>`);
    this.splash = $(`<div class="splash"></div>`);
    this.debugEl = $(`<pre class="debug hidden"></pre>`);
    this.hint = $(`<div class="hint">SPACE skip intro · R rerun · N new seed · A new arena (⇧A same theme) · T next theme · Q quality · ESC menu · L letterbox · C free-cam · \` debug · P pause · M mute · V audio</div>`);
    this.menu = $(`<div class="menu hidden"></div>`);
    this.subEl = $(`<div class="subtitle"><div class="sub-name"></div><div class="sub-text"></div></div>`);
    this.settingsEl = $(`<div class="settings hidden"></div>`);
    this.results = $(`<div class="results hidden"></div>`);
    root.append(this.lb, this.hud, this.toastEl, this.title, this.splash, this.subEl, this.debugEl, this.hint, this.menu, this.results, this.settingsEl);
  }

  // ---------------------------------------------------------------- HUD
  setFighters(a: FighterDef, b: FighterDef) {
    const defs = [a, b];
    this.bars.forEach((bar, i) => {
      bar.name.innerHTML = `<b>${defs[i].name}</b> <i>${defs[i].epithet}</i>`;
      bar.wrap.style.setProperty('--accent', defs[i].color);
    });
    this.trailHp = [1, 1];
  }
  showHud(v: boolean) {
    this.hud.classList.toggle('hidden', !v);
  }
  updateHud(fr: Frame, maxHp: [number, number], maxSt: [number, number], dt: number) {
    for (let i = 0; i < 2; i++) {
      const f = fr.f[i];
      const hp = Math.max(0, f.hp / maxHp[i]);
      // damage trail lags behind for readability
      if (this.trailHp[i] > hp) this.trailHp[i] = Math.max(hp, this.trailHp[i] - dt * 0.35);
      else this.trailHp[i] = hp;
      const b = this.bars[i];
      b.hp.style.width = `${hp * 100}%`;
      b.trail.style.width = `${this.trailHp[i] * 100}%`;
      b.hp.classList.toggle('low', hp < 0.25);
      b.st.style.width = `${Math.max(0, f.stamina / maxSt[i]) * 100}%`;
      b.fury.style.width = `${Math.min(100, f.fury)}%`;
      b.fury.parentElement!.classList.toggle('full', f.fury >= 100);
      b.wrap.classList.toggle('buffed', f.buff > 0 || f.lastStand);
    }
    this.timer.textContent = `${Math.floor(fr.t)}`;
    const m = Math.max(-1, Math.min(1, fr.momentum));
    this.mom.style.left = m >= 0 ? '50%' : `${50 + m * 50}%`;
    this.mom.style.width = `${Math.abs(m) * 50}%`;
    this.mom.style.background = m >= 0 ? this.bars[0].wrap.style.getPropertyValue('--accent') : this.bars[1].wrap.style.getPropertyValue('--accent');
  }

  toast(main: string, sub = '', color = '#ffd27a', dur = 1.8) {
    this.toastEl.querySelector('.t-main')!.textContent = main;
    this.toastEl.querySelector('.t-sub')!.textContent = sub;
    (this.toastEl as HTMLElement).style.setProperty('--c', color);
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), dur * 1000);
  }

  setLetterbox(on: boolean) {
    this.lb.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- cinematic text
  showTitle(def: FighterDef, opp: FighterDef, side: 0 | 1) {
    this.title.querySelector('.tc-epi')!.textContent = def.epithet.toUpperCase();
    this.title.querySelector('.tc-name')!.textContent = def.name;
    this.title.querySelector('.tc-bio')!.textContent = def.bio;
    this.title.querySelector('.tc-grudge')!.textContent = def.grudge.replace(/\{opp\}/g, opp.name);
    this.title.style.setProperty('--accent', def.color);
    this.title.classList.toggle('right', side === 1);
    this.title.classList.remove('show');
    void this.title.offsetWidth;
    this.title.classList.add('show');
  }
  hideTitle() {
    this.title.classList.remove('show');
  }
  splashText(html: string, cls = '') {
    this.splash.className = `splash ${cls}`;
    this.splash.innerHTML = html;
    void this.splash.offsetWidth;
    this.splash.classList.add('show');
  }
  hideSplash() {
    this.splash.className = 'splash';
  }

  // ---------------------------------------------------------------- subtitles
  subtitle(name: string, text: string, color: string, dur: number) {
    this.subEl.querySelector('.sub-name')!.textContent = name.toUpperCase();
    this.subEl.querySelector('.sub-text')!.textContent = text;
    this.subEl.style.setProperty('--accent', color);
    this.subEl.classList.remove('show');
    void this.subEl.offsetWidth;
    this.subEl.classList.add('show');
    clearTimeout(this.subTimer);
    this.subTimer = window.setTimeout(() => this.subEl.classList.remove('show'), dur * 1000);
  }

  // ---------------------------------------------------------------- audio settings
  /** Volume panel (master/sfx/voice/music), values 0..1. */
  toggleSettings(values: Record<string, number>, onChange: (k: string, v: number) => void) {
    if (!this.settingsEl.classList.contains('hidden')) {
      this.settingsEl.classList.add('hidden');
      return;
    }
    const keys = ['master', 'sfx', 'voice', 'music'];
    this.settingsEl.innerHTML = `<div class="set-inner"><h3>AUDIO</h3>${keys
      .map((k) => `<label><span>${k}</span><input type="range" min="0" max="100" value="${Math.round(values[k] * 100)}" data-k="${k}"><b>${Math.round(values[k] * 100)}</b></label>`)
      .join('')}<button class="set-close">Close (V)</button></div>`;
    this.settingsEl.querySelectorAll<HTMLInputElement>('input').forEach((el) =>
      el.addEventListener('input', () => {
        onChange(el.dataset.k!, Number(el.value) / 100);
        el.nextElementSibling!.textContent = el.value;
      }),
    );
    this.settingsEl.querySelector('.set-close')!.addEventListener('click', () => this.settingsEl.classList.add('hidden'));
    this.settingsEl.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- debug
  toggleDebug() {
    this.debugEl.classList.toggle('hidden');
  }
  get debugVisible() {
    return !this.debugEl.classList.contains('hidden');
  }
  setDebug(text: string) {
    if (this.debugVisible) this.debugEl.textContent = text;
  }

  // ---------------------------------------------------------------- menu
  openMenu(initial: MenuChoice, onStart: (c: MenuChoice) => void) {
    let a = initial.a,
      b = initial.b;
    const card = (f: FighterDef, side: 'a' | 'b') =>
      `<button class="fcard" data-side="${side}" data-id="${f.id}" style="--accent:${f.color}"><b>${f.name}</b><i>${f.epithet}</i><small>${f.moves.find((m) => m.kind === 'ultimate')?.name ?? ''}</small></button>`;
    this.menu.innerHTML = `
      <div class="menu-inner">
        <h1>THE ARENA</h1>
        <p class="sub">Choose two champions. The gods will watch.</p>
        <div class="cols">
          <div class="col"><h3>West Gate</h3>${FIGHTERS.map((f) => card(f, 'a')).join('')}<button class="rnd" data-side="a">Random</button></div>
          <div class="vs">VS</div>
          <div class="col"><h3>East Gate</h3>${FIGHTERS.map((f) => card(f, 'b')).join('')}<button class="rnd" data-side="b">Random</button></div>
        </div>
        <h3 class="arena-h">Arena</h3>
        <div class="themes">${['random', ...THEMES]
          .map((t) => {
            if (t === 'random') return `<button class="theme" data-theme="random" style="--sky:linear-gradient(160deg,#444,#888)"><b>Random</b><i>any realm</i></button>`;
            const T = THEME_DEFS[t as ThemeId];
            const z = '#' + T.sky.zenith.getHexString(),
              h = '#' + T.sky.horizon.getHexString(),
              g = '#' + T.sky.horizonGlow.getHexString();
            return `<button class="theme" data-theme="${t}" style="--sky:linear-gradient(180deg,${z} 0%,${h} 62%,${g} 78%,${T.accent} 100%)"><b>${T.name.replace('The ', '')}</b><i>${T.tagline}</i></button>`;
          })
          .join('')}</div>
        <div class="row">
          <label>Layout <select class="layout">${['random', ...LAYOUTS].map((l) => `<option value="${l}" ${initial.arena.layout === l ? 'selected' : ''}>${l === 'random' ? 'Random' : LAYOUT_LABEL[l as LayoutId]}</option>`).join('')}</select></label>
          <label>Arena seed <input class="aseed" type="number" value="${initial.arena.seed}"></label>
          <button class="rearena" title="reroll arena">🎲</button>
        </div>
        <div class="row">
          <label>Fight seed <input class="seed" type="number" value="${initial.seed}"></label>
          <button class="reseed">🎲</button>
          <label class="chk"><input class="skip" type="checkbox" ${initial.skipIntro ? 'checked' : ''}> Skip entrances</label>
        </div>
        <button class="go">ENTER THE ARENA</button>
        <button class="audio-btn">Audio settings (V)</button>
      </div>`;
    let theme = initial.arena.theme;
    const sync = () => {
      this.menu.querySelectorAll<HTMLButtonElement>('.fcard').forEach((el) => {
        el.classList.toggle('sel', (el.dataset.side === 'a' ? a : b) === el.dataset.id);
      });
      this.menu.querySelectorAll<HTMLButtonElement>('.theme').forEach((el) => el.classList.toggle('sel', el.dataset.theme === theme));
    };
    this.menu.querySelectorAll<HTMLButtonElement>('.theme').forEach((el) =>
      el.addEventListener('click', () => {
        theme = el.dataset.theme as ThemeId | 'random';
        sync();
      }),
    );
    const aseedIn = this.menu.querySelector<HTMLInputElement>('.aseed')!;
    this.menu.querySelector('.rearena')!.addEventListener('click', () => (aseedIn.value = String(Math.floor(Math.random() * 1e6))));
    sync();
    this.menu.querySelectorAll<HTMLButtonElement>('.fcard').forEach((el) =>
      el.addEventListener('click', () => {
        if (el.dataset.side === 'a') a = el.dataset.id!;
        else b = el.dataset.id!;
        sync();
      }),
    );
    this.menu.querySelectorAll<HTMLButtonElement>('.rnd').forEach((el) =>
      el.addEventListener('click', () => {
        const pick = () => FIGHTERS[Math.floor(Math.random() * FIGHTERS.length)].id;
        if (el.dataset.side === 'a') do a = pick(); while (a === b);
        else do b = pick(); while (a === b);
        sync();
      }),
    );
    const seedIn = this.menu.querySelector<HTMLInputElement>('.seed')!;
    this.menu.querySelector('.reseed')!.addEventListener('click', () => (seedIn.value = String(Math.floor(Math.random() * 1e6))));
    this.menu.querySelector('.audio-btn')!.addEventListener('click', () => this.onAudioSettings?.());
    this.menu.querySelector('.go')!.addEventListener('click', () => {
      this.menu.classList.add('hidden');
      onStart({
        a,
        b,
        seed: Number(seedIn.value) || 1,
        skipIntro: this.menu.querySelector<HTMLInputElement>('.skip')!.checked,
        arena: { theme, layout: this.menu.querySelector<HTMLSelectElement>('.layout')!.value as LayoutId | 'random', seed: Number(aseedIn.value) || 1 },
      });
    });
    this.menu.classList.remove('hidden');
  }
  onAudioSettings?: () => void;
  private arenaLabel?: HTMLElement;
  /** small arena name tag (bottom-left) */
  setArenaLabel(text: string) {
    if (!this.arenaLabel) {
      this.arenaLabel = $(`<div class="arena-label"></div>`);
      this.root.append(this.arenaLabel);
    }
    this.arenaLabel.textContent = text;
  }
  get menuOpen() {
    return !this.menu.classList.contains('hidden');
  }
  closeMenu() {
    this.menu.classList.add('hidden');
  }

  showResults(res: MatchResult, defs: [FighterDef, FighterDef], seed: number, on: { rerun: () => void; reseed: () => void; menu: () => void }) {
    const w = res.winner >= 0 ? defs[res.winner] : null;
    this.results.innerHTML = `
      <div class="res-inner" style="--accent:${w?.color ?? '#ccc'}">
        <div class="res-epi">${res.timeout ? 'BY DECISION' : 'VICTORY'}</div>
        <div class="res-name">${w ? `${w.name} <i>${w.epithet}</i>` : 'A DRAW'}</div>
        <div class="res-stats">${res.duration.toFixed(1)}s · ${res.swings} momentum swing${res.swings === 1 ? '' : 's'}${res.comeback ? ' · COMEBACK' : ''} · seed ${seed}</div>
        <div class="res-btns"><button class="b-rerun">Rerun (R)</button><button class="b-reseed">New seed (N)</button><button class="b-menu">Menu (Esc)</button></div>
      </div>`;
    this.results.querySelector('.b-rerun')!.addEventListener('click', on.rerun);
    this.results.querySelector('.b-reseed')!.addEventListener('click', on.reseed);
    this.results.querySelector('.b-menu')!.addEventListener('click', on.menu);
    this.results.classList.remove('hidden');
  }
  hideResults() {
    this.results.classList.add('hidden');
  }
}
