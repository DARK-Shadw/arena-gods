/**
 * ANIMATION LAB (dev tool):  npm run dev  ->  http://localhost:5173/tools/animlab/
 *
 * Preview any clip on any fighter: the built shared library (with measured
 * events + root curves), the fighter's own GLB clips, or ANY raw catalogued
 * FBX (served from ../Assets by the dev-only /src-assets middleware) retargeted
 * on the fly. Two actors side by side (retarget check / mirror check), root
 * motion toggle, trajectories, event markers, frame stepping.
 *
 * URL: ?a=gorak&b=vex&clip=lib:Head_Hit&clipB=lib:Head_Hit~M&t=0.4&src=lib&q=filter&root=1&pause=1
 * Test hooks: window.__lab.{show(a, clip, b?, clipB?), seek(t), ready}
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { FIGHTERS } from '../../src/sim/fighters';
import { instantiate, loadCharacter, type CharAsset } from '../../src/render/character';
import { buildLibClip, decodeClip, initLib, libClip, libIndexSync, rootAt, type DecodedClip } from '../../src/render/animLib';
import { attachLab } from './labExtras';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qs = new URLSearchParams(location.search);

// ------------------------------------------------------------------ scene
const canvas = $('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2d33');
scene.fog = new THREE.Fog('#2a2d33', 18, 40);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
camera.position.set(0.8, 1.6, 5.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0.8, 0.95, 0);
scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a3028', 1.4));
const sun = new THREE.DirectionalLight('#fff2dc', 2.4);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
sun.shadow.camera.right = sun.shadow.camera.top = 6;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#3b3d42', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(60, 60, '#5a5e66', '#44474e');
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.5;
grid.position.y = 0.002;
scene.add(grid);

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ actors
interface Actor {
  fid: string;
  asset: CharAsset;
  root: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction | null;
  clipName: string;
  decoded: DecodedClip | null;
  dur: number;
  base: THREE.Vector3;
  skel: THREE.SkeletonHelper;
  trails: Record<string, { pts: THREE.Vector3[]; line: THREE.Line }>;
  hipsCm: number;
  hipsM: number;
}
const actors: (Actor | null)[] = [null, null];

async function makeActor(slot: number, fid: string): Promise<Actor> {
  const old = actors[slot];
  if (old) {
    scene.remove(old.root, old.skel);
    for (const t of Object.values(old.trails)) scene.remove(t.line);
  }
  const asset = await loadCharacter(fid);
  const model = instantiate(asset);
  model.scale.setScalar(0.01 * asset.meta.scale);
  const root = new THREE.Group();
  root.add(model);
  const base = new THREE.Vector3(slot === 0 ? 0 : 1.7, 0, 0);
  root.position.copy(base);
  scene.add(root);
  const skel = new THREE.SkeletonHelper(model);
  skel.visible = ($('skel') as HTMLInputElement).checked;
  scene.add(skel);
  const trails: Actor['trails'] = {};
  const colors: Record<string, string> = { Hips: '#ffd060', LeftHand: '#5aa0ff', RightHand: '#ff5a5a', LeftFoot: '#3a70d0', RightFoot: '#d03a3a' };
  for (const [j, c] of Object.entries(colors)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400 * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.8 }));
    line.frustumCulled = false;
    scene.add(line);
    trails[j] = { pts: [], line };
  }
  const a: Actor = { fid, asset, root, model, mixer: new THREE.AnimationMixer(model), action: null, clipName: '', decoded: null, dur: 1, base, skel, trails, hipsCm: asset.meta.hipsY, hipsM: asset.meta.hipsY * 0.01 * asset.meta.scale };
  actors[slot] = a;
  return a;
}

// raw FBX retarget (same rules as the converter: rotations + hips height ratio)
const fbxCache = new Map<string, Promise<THREE.AnimationClip>>();
const rawHips = new WeakMap<THREE.AnimationClip, number>();
function loadRaw(rel: string): Promise<THREE.AnimationClip> {
  if (!fbxCache.has(rel))
    fbxCache.set(
      rel,
      new FBXLoader().loadAsync('/src-assets/Animations/' + rel).then((g) => {
        const c = g.animations.find((x) => x.duration > 0.05) ?? g.animations[0];
        let hipsRest = 100;
        g.traverse((o) => {
          if ((o as THREE.Bone).isBone && /Hips$/.test(o.name)) {
            g.updateMatrixWorld(true);
            hipsRest = o.getWorldPosition(new THREE.Vector3()).y;
          }
        });
        rawHips.set(c, hipsRest);
        return c;
      }),
    );
  return fbxCache.get(rel)!;
}
function retargetRaw(a: Actor, src: THREE.AnimationClip, rootMotion: boolean): THREE.AnimationClip {
  const hipsRest = rawHips.get(src) || 100;
  const ratio = a.hipsCm / hipsRest;
  const tracks: THREE.KeyframeTrack[] = [];
  let hipsName = 'mixamorigHips';
  a.model.traverse((o) => {
    if ((o as THREE.Bone).isBone && /Hips$/.test(o.name)) hipsName = o.name;
  });
  const hips = a.model.getObjectByName(hipsName)!;
  const rest = hips.userData.restPos ?? (hips.userData.restPos = hips.position.clone());
  for (const t of src.tracks) {
    const [node, prop] = t.name.split('.');
    const nm = node.replace(/^mixamorig\d*:?/, '');
    const target = hipsName.replace(/Hips$/, '') + nm;
    if (!a.model.getObjectByName(target)) continue;
    if (prop === 'quaternion') tracks.push(new THREE.QuaternionKeyframeTrack(target + '.quaternion', Array.from(t.times), Array.from(t.values)));
    else if (prop === 'position' && nm === 'Hips') {
      const v = Array.from(t.values);
      const x0 = v[0],
        z0 = v[2];
      for (let i = 0; i < v.length; i += 3) {
        v[i] = rootMotion ? rest.x + (v[i] - x0) * ratio : rest.x;
        v[i + 1] = v[i + 1] * ratio;
        v[i + 2] = rootMotion ? rest.z + (v[i + 2] - z0) * ratio : rest.z;
      }
      tracks.push(new THREE.VectorKeyframeTrack(target + '.position', Array.from(t.times), v));
    }
  }
  return new THREE.AnimationClip('raw', src.duration, tracks);
}

const ownRoot = () => ($('root') as HTMLInputElement).checked;

async function setClip(a: Actor, ref: string) {
  a.mixer.stopAllAction();
  a.decoded = null;
  a.root.userData.sceneFix = false;
  a.base.set(actors.indexOf(a) === 1 ? 1.7 : 0, 0, 0);
  let clip: THREE.AnimationClip | null = null;
  if (ref.startsWith('lib:')) {
    const id = ref.slice(4);
    a.decoded = decodeClip(id);
    clip = buildLibClip(id, a.model, a.hipsCm, ownRoot() ? 'root' : 'inplace');
  } else if (ref.startsWith('own:')) {
    clip = a.asset.clips.find((c) => c.name === ref.slice(4)) ?? null;
  } else if (ref.startsWith('raw:')) {
    clip = retargetRaw(a, await loadRaw(ref.slice(4)), ownRoot());
  }
  if (!clip) {
    a.clipName = ref + ' (n/a for this fighter)';
    return;
  }
  a.clipName = ref;
  a.action = a.mixer.clipAction(clip);
  a.action.play();
  a.action.paused = true;
  a.dur = clip.duration;
  for (const t of Object.values(a.trails)) t.pts.length = 0;
  buildTimeline();
}

// ------------------------------------------------------------------ playback
let t = Number(qs.get('t') ?? 0);
let playing = qs.get('pause') !== '1';
const speed = () => Number(($('spd') as HTMLSelectElement).value);
const dur = () => Math.max(actors[0]?.dur ?? 1, actors[1]?.dur ?? 0);
const tmp = new THREE.Vector3();

function apply() {
  for (const a of actors) {
    if (!a || !a.action) continue;
    const tt = Math.min(t, a.dur - 1e-3);
    a.action.time = tt;
    a.mixer.update(0);
    // root motion for library clips: move the actor root by the clip's root curve
    a.root.position.copy(a.base);
    if (!a.root.userData.sceneFix) a.root.rotation.y = 0;
    if (a.decoded && ownRoot()) {
      // (hips already carry the full path in 'root' mode)
    }
    a.root.updateMatrixWorld(true);
    if (($('trail') as HTMLInputElement).checked) {
      for (const [j, tr] of Object.entries(a.trails)) {
        const b = a.model.getObjectByName('mixamorig' + j) ?? a.model.getObjectByName(j);
        if (!b) continue;
        b.getWorldPosition(tmp);
        const last = tr.pts[tr.pts.length - 1];
        if (!last || last.distanceToSquared(tmp) > 1e-6) tr.pts.push(tmp.clone());
        if (tr.pts.length > 400) tr.pts.shift();
        const pa = tr.line.geometry.getAttribute('position') as THREE.BufferAttribute;
        tr.pts.forEach((p, k) => pa.setXYZ(k, p.x, p.y, p.z));
        pa.needsUpdate = true;
        tr.line.geometry.setDrawRange(0, tr.pts.length);
      }
    }
  }
}

function hud() {
  const lines: string[] = [];
  actors.forEach((a, i) => {
    if (!a) return;
    lines.push(`${i === 0 ? 'A' : 'B'} ${a.fid}  ${a.clipName}  t ${Math.min(t, a.dur).toFixed(2)} / ${a.dur.toFixed(2)}s  frame ${Math.round(Math.min(t, a.dur) * 30)}`);
    const d = a.decoded;
    if (d) {
      const m = d.info.meta;
      const r = rootAt(d, Math.min(t, d.dur));
      lines.push(`  role ${d.info.role}${d.info.tags.length ? ' [' + d.info.tags.join(',') + ']' : ''}${d.info.mirrorOf ? ' (mirror of ' + d.info.mirrorOf + ')' : ''}  posture ${m.posture.join('>')}  face ${m.startFace}/${m.endFace}`);
      lines.push(`  from ${m.from ?? '-'} sev ${m.sev ?? '-'} ${m.height ?? ''}  impact ${m.impactT ?? '-'}  ground ${m.groundT}  apex ${m.apexT} lift ${m.lift}  travel ${m.travel.map((v) => (v * a.hipsM).toFixed(2)).join(',')} m  root now ${(r.x * a.hipsM).toFixed(2)},${(r.z * a.hipsM).toFixed(2)} m  trim ${m.trim.join('/')}`);
      lines.push(`  src ${d.info.src}`);
    }
  });
  $('hud').textContent = lines.join('\n');
}

function buildTimeline() {
  const tl = $('tl');
  tl.querySelectorAll('.mk,.lb').forEach((e) => e.remove());
  const a = actors[0];
  const D = dur();
  const mark = (time: number, color: string, label: string) => {
    if (time < 0 || time > D) return;
    const m = document.createElement('div');
    m.className = 'mk';
    m.style.left = `${(time / D) * 100}%`;
    m.style.background = color;
    tl.appendChild(m);
    const l = document.createElement('div');
    l.className = 'lb';
    l.style.left = `${(time / D) * 100}%`;
    l.textContent = label;
    tl.appendChild(l);
  };
  if (a?.decoded) {
    const m = a.decoded.info.meta;
    if (m.impactT !== undefined) mark(m.impactT, '#ff5050', 'impact');
    if (m.groundT >= 0) mark(m.groundT, '#50c0ff', 'ground');
    if (m.lift > 0.05) mark(m.apexT, '#c080ff', 'apex');
  }
  if (a && a.clipName.startsWith('own:')) {
    const cm = a.asset.meta.clips[a.clipName.slice(4)];
    if (cm?.strike) mark(cm.strike, '#ff5050', 'strike');
    for (const p of cm?.peaks ?? []) if (Math.abs(p - cm.strike) > 0.05) mark(p, '#ff9050', 'peak');
    if (cm?.start) mark(cm.start, '#90ff90', 'start');
  }
}

let lastT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (playing) {
    t += dt * speed();
    if (t > dur()) {
      if (($('loop') as HTMLInputElement).checked) {
        t = 0;
        for (const a of actors) if (a) for (const tr of Object.values(a.trails)) tr.pts.length = 0;
      } else t = dur();
    }
  }
  apply();
  $('ph').style.left = `${(t / dur()) * 100}%`;
  hud();
  controls.update();
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ UI
let current = '';
let source = qs.get('src') ?? 'lib';
const catalogP = fetch('/docs/animation-catalog.json')
  .then((r) => r.json())
  .then((j) => (j.clips as { id: string; name: string; cat: string; error?: string; desc?: string }[]).filter((c) => !c.error))
  .catch(() => []);

async function rebuildList() {
  const list = $('list');
  list.innerHTML = '';
  const f = ($('q') as HTMLInputElement).value.trim().toLowerCase();
  const items: { grp: string; ref: string; label: string; title?: string }[] = [];
  if (source === 'lib') {
    for (const c of libIndexSync()?.clips ?? []) {
      const m = c.meta;
      const hay = `${c.id} ${c.role} ${c.tags.join(' ')} from:${(m.from ?? '').toLowerCase()} sev:${m.sev ?? ''} ${m.posture.join('>')} ${m.endFace} dir:${(m.dir ?? '').toLowerCase()}`.toLowerCase();
      if (f && !f.split(/\s+/).every((w) => hay.includes(w))) continue;
      items.push({ grp: c.role, ref: 'lib:' + c.id, label: `${c.id}  ${m.from ? m.from + m.sev : m.dir ?? ''} ${m.dur.toFixed(1)}s`, title: c.src });
    }
  } else if (source === 'own') {
    const a = actors[0];
    for (const c of a?.asset.clips ?? []) if (!f || c.name.toLowerCase().includes(f)) items.push({ grp: a!.fid, ref: 'own:' + c.name, label: `${c.name}  ${c.duration.toFixed(1)}s` });
  } else {
    for (const c of await catalogP) {
      const hay = `${c.id} ${c.cat} ${c.desc ?? ''}`.toLowerCase();
      if (f && !f.split(/\s+/).every((w) => hay.includes(w))) continue;
      items.push({ grp: c.cat ?? 'misc', ref: 'raw:' + c.id, label: c.name, title: c.desc });
    }
  }
  items.sort((a, b) => a.grp.localeCompare(b.grp));
  let g = '';
  for (const it of items) {
    if (it.grp !== g) {
      g = it.grp;
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = g;
      list.appendChild(h);
    }
    const d = document.createElement('div');
    d.className = 'it' + (it.ref === current ? ' sel' : '');
    d.textContent = it.label;
    if (it.title) d.title = it.title;
    d.onclick = (ev) => pick(it.ref, ev.shiftKey);
    list.appendChild(d);
  }
  $('info').textContent = `${items.length} clips`;
}

async function pick(ref: string, bOnly = false) {
  current = ref;
  if (!bOnly && actors[0]) await setClip(actors[0], ref);
  if (actors[1]) {
    const mirror = ($('mirrorB') as HTMLInputElement).checked && ref.startsWith('lib:');
    let refB = ref;
    if (mirror) {
      const id = ref.slice(4);
      const c = libClip(id);
      refB = c?.mirrorOf ? 'lib:' + c.mirrorOf : libClip(id + '~M') ? 'lib:' + id + '~M' : ref;
    }
    await setClip(actors[1], refB);
  }
  t = 0;
  rebuildList();
}

function initUI() {
  const fa = $('fa') as HTMLSelectElement,
    fb = $('fb') as HTMLSelectElement;
  for (const f of FIGHTERS) {
    fa.add(new Option(f.name + ' (' + f.id + ')', f.id));
    fb.add(new Option(f.name + ' (' + f.id + ')', f.id));
  }
  fa.value = qs.get('a') ?? 'gorak';
  fb.value = qs.get('b') ?? '';
  fa.onchange = async () => {
    const a = await makeActor(0, fa.value);
    if (current) await setClip(a, current);
    rebuildList();
  };
  fb.onchange = async () => {
    if (!fb.value) {
      const b = actors[1];
      if (b) {
        scene.remove(b.root, b.skel);
        for (const tr of Object.values(b.trails)) scene.remove(tr.line);
      }
      actors[1] = null;
      return;
    }
    const b = await makeActor(1, fb.value);
    if (current) await pick(current);
    void b;
  };
  const src = $('src') as HTMLSelectElement;
  src.value = source;
  src.onchange = () => {
    source = src.value;
    rebuildList();
  };
  const q = $('q') as HTMLInputElement;
  q.value = qs.get('q') ?? '';
  q.oninput = () => rebuildList();
  $('play').onclick = () => (playing = !playing);
  $('prev').onclick = () => {
    playing = false;
    t = Math.max(0, t - 1 / 30);
  };
  $('next').onclick = () => {
    playing = false;
    t = Math.min(dur(), t + 1 / 30);
  };
  ($('skel') as HTMLInputElement).onchange = (e) => actors.forEach((a) => a && (a.skel.visible = (e.target as HTMLInputElement).checked));
  ($('root') as HTMLInputElement).checked = qs.get('root') === '1';
  ($('root') as HTMLInputElement).onchange = () => current && pick(current);
  ($('mirrorB') as HTMLInputElement).onchange = () => current && pick(current);
  const tl = $('tl');
  const seekFromEvent = (e: MouseEvent) => {
    const r = tl.getBoundingClientRect();
    t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur();
    playing = false;
  };
  tl.onmousedown = (e) => {
    seekFromEvent(e);
    const mv = (ev: MouseEvent) => seekFromEvent(ev);
    addEventListener('mousemove', mv);
    addEventListener('mouseup', () => removeEventListener('mousemove', mv), { once: true });
  };
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      playing = !playing;
    } else if (e.key === ',') (playing = false), (t = Math.max(0, t - 1 / 30));
    else if (e.key === '.') (playing = false), (t = Math.min(dur(), t + 1 / 30));
    else if (e.key === 'm' || e.key === 'M') ($('mirrorB') as HTMLInputElement).click();
    else if (e.key === 'r' || e.key === 'R') ($('root') as HTMLInputElement).click();
    else if (e.key === 'k' || e.key === 'K') ($('skel') as HTMLInputElement).click();
    else if ('1234'.includes(e.key)) ($('spd') as HTMLSelectElement).value = ['0.1', '0.25', '0.5', '1'][Number(e.key) - 1];
  });
}

// ------------------------------------------------------------------ boot
(async () => {
  resize();
  initUI();
  await initLib('core', 'entrance', 'finisher');
  await makeActor(0, ($('fa') as HTMLSelectElement).value);
  if (($('fb') as HTMLSelectElement).value) await makeActor(1, ($('fb') as HTMLSelectElement).value);
  const c0 = qs.get('clip');
  if (c0) {
    await pick(c0);
    const cb = qs.get('clipB');
    if (cb && actors[1]) await setClip(actors[1], cb);
  }
  t = Number(qs.get('t') ?? 0);
  await rebuildList();
  frame();
  const api = {
    ready: true,
    actors,
    scene,
    camera,
    controls,
    renderer,
    async show(a: string, clip: string, b?: string, clipB?: string) {
      ($('fa') as HTMLSelectElement).value = a;
      await makeActor(0, a);
      if (b) {
        ($('fb') as HTMLSelectElement).value = b;
        await makeActor(1, b);
      }
      await pick(clip);
      if (clipB && actors[1]) await setClip(actors[1], clipB);
      t = 0;
    },
    seek(tt: number) {
      playing = false;
      t = tt;
      apply();
      renderer.render(scene, camera);
    },
    /** M0 acceptance: retarget every catalogued raw FBX onto each fighter and sample it (no NaNs, bones driven) */
    async checkRaw(fighters: string[], limit = 9999) {
      const cat = (await catalogP).slice(0, limit);
      const fails: string[] = [];
      let ok = 0;
      const acts: Actor[] = [];
      for (const f of fighters) acts.push(await makeActor(acts.length % 2, f));
      for (const c of cat) {
        let src: THREE.AnimationClip;
        try {
          src = await loadRaw(c.id);
        } catch (e) {
          fails.push(`${c.id}: load ${(e as Error).message}`);
          fbxCache.delete(c.id);
          continue;
        }
        for (const a of acts) {
          const clip = retargetRaw(a, src, false);
          const mixer = new THREE.AnimationMixer(a.model);
          const act = mixer.clipAction(clip);
          act.play();
          act.time = clip.duration * 0.5;
          mixer.update(0);
          let bad = clip.tracks.length < 20;
          a.model.traverse((o) => {
            if ((o as THREE.Bone).isBone && !Number.isFinite(o.quaternion.x + o.position.y)) bad = true;
          });
          act.stop();
          mixer.uncacheRoot(a.model);
          if (bad) fails.push(`${c.id} on ${a.fid}: ${clip.tracks.length} tracks / NaN`);
          else ok++;
        }
        fbxCache.delete(c.id);
      }
      return { clips: cat.length, fighters, ok, fails };
    },
    view(p: [number, number, number], look: [number, number, number]) {
      camera.position.set(...p);
      controls.target.set(...look);
      controls.update();
    },
  };
  (window as unknown as { __lab: typeof api }).__lab = api;
  attachLab(api);
})();
