/**
 * A21: the match loading screen. A dark veil over the canvas with the arena's name, a thin progress bar and one
 * status line, shown while a match loads (fighters, animation library, arena art, shader warm-up) and faded out when
 * the intro or the fight starts. Progress is weighted by the expected download size of each part (approximate:
 * the arena's kit files carry their sizes in the manifest; fighters / library use fixed estimates).
 * Pure DOM, no frame-loop work besides `update()` while it is shown.
 */
export interface LoadPart {
  /** expected weight (about MB on the wire) */
  total: number;
  /** completed weight */
  done: number;
}

export class LoadingScreen {
  private el: HTMLDivElement;
  private bar: HTMLDivElement;
  private status: HTMLDivElement;
  private title: HTMLDivElement;
  private parts = new Map<string, LoadPart>();
  private shown = false;
  private shownFrac = 0;
  private label = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'loading';
    this.el.innerHTML = `<div class="loading-box"><div class="loading-kicker">THE GATES OPEN</div><div class="loading-title"></div><div class="loading-track"><div class="loading-bar"></div></div><div class="loading-status"></div></div>`;
    this.title = this.el.querySelector('.loading-title')!;
    this.bar = this.el.querySelector('.loading-bar')!;
    this.status = this.el.querySelector('.loading-status')!;
    root.append(this.el);
  }

  get visible() {
    return this.shown;
  }

  show(title: string) {
    this.parts.clear();
    this.shownFrac = 0;
    this.title.textContent = title;
    this.bar.style.transform = 'scaleX(0)';
    this.status.textContent = '';
    this.shown = true;
    this.el.classList.add('show');
  }

  setTitle(title: string) {
    this.title.textContent = title;
  }

  /** register / update one part of the load (weights in about MB) */
  part(key: string, done: number, total: number) {
    this.parts.set(key, { done: Math.min(done, total), total });
  }

  /** the status line ('Fighters', 'The arena', 'Preparing shaders' ...) */
  stage(label: string) {
    this.label = label;
  }

  /** fade out (intro start) or vanish at once (`instant`: straight into a fight, test harness screenshots) */
  hide(instant = false) {
    if (!this.shown) return;
    this.shown = false;
    this.bar.style.transform = 'scaleX(1)';
    if (instant) {
      this.el.style.transition = 'none';
      this.el.classList.remove('show');
      void this.el.offsetWidth;
      this.el.style.transition = '';
    } else this.el.classList.remove('show');
  }

  /** per frame while shown: ease the bar toward the weighted progress (it never moves backwards) */
  update(dt: number) {
    if (!this.shown) return;
    let d = 0,
      t = 0;
    for (const p of this.parts.values()) (d += p.done), (t += p.total);
    const f = t > 0 ? d / t : 0;
    const target = Math.max(this.shownFrac, Math.min(0.995, f));
    this.shownFrac += (target - this.shownFrac) * Math.min(1, dt * 8);
    this.bar.style.transform = `scaleX(${this.shownFrac.toFixed(4)})`;
    const pct = `${Math.floor(this.shownFrac * 100)} %`;
    const s = this.label ? `${this.label} · ${pct}` : pct;
    if (this.status.textContent !== s) this.status.textContent = s;
  }
}
