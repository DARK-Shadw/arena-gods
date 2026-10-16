/**
 * ARENA WORLD RUNTIME (deterministic, headless): the destructible / interactive
 * part of the arena that lives inside the simulation.
 *
 *  - obstacles: cover (blocks movement, projectiles and line of sight), damaged
 *    progressively by projectiles, slams, melee and thrown props; toppleable
 *    ones fall in the direction of the blow and CRUSH what's in their path
 *    when they visibly land, then shatter into throwable rubble chunks
 *  - props: breakables (crates, barrels, urns, braziers, lanterns), throwables
 *    (pick-up -> carry -> throw, timed to the Throw_Object clip), explosives
 *    (fuse -> blast that chains)
 *  - hazards: lava / fire pits (burst + pop-out), pressure-plate spike traps,
 *    geysers (periodic), shallow water (slow), chandeliers / stalactites
 *    shaken loose by nearby impacts
 *
 * Every damage here follows the contact rule: it is applied on the tick the
 * thing visibly reaches the fighter (prop capsule sweep, column landing, blast).
 */
import { atan2, cos, hypot, sin } from './dmath';
import type { ArenaLayout, PropKind } from './arenaGen';
import { boundR } from './arenaGen';
import type { FighterState, Match } from './match';
import { segSegDist } from './reach';

/** prop states */
export const PS_REST = 0,
  PS_CARRIED = 1,
  PS_FLYING = 2,
  PS_GONE = 3;

/**
 * Throw_Object.fbx timing (clip seconds). The sim's lift/throw states map
 * linearly onto these segments; the renderer uses the same table.
 */
export const THROW_CLIP = { liftFrom: 0.45, grab: 1.0, liftTo: 1.9, throwFrom: 1.9, release: 2.383, throwTo: 3.2 };
export const LIFT_DUR = 0.95;
export const THROW_DUR = 1.0;
export const LIFT_GRAB = ((THROW_CLIP.grab - THROW_CLIP.liftFrom) / (THROW_CLIP.liftTo - THROW_CLIP.liftFrom)) * LIFT_DUR;
export const THROW_RELEASE = ((THROW_CLIP.release - THROW_CLIP.throwFrom) / (THROW_CLIP.throwTo - THROW_CLIP.throwFrom)) * THROW_DUR;
const G = 9.8;
const TOPPLE_FALL = 0.9; // s from first lean to impact

export type RtPropKind = PropKind | 'chunk';
export interface PropRT {
  id: number;
  kind: RtPropKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rot: number;
  spin: number;
  r: number;
  hp: number;
  maxHp: number;
  mass: number;
  throwable: boolean;
  explosive: boolean;
  state: number;
  carrier: number;
  owner: number;
  /** explosive fuse: explode at this time (-1 = not lit) */
  fuseAt: number;
  /** height of the prop's top (for projectile hits) */
  top: number;
}
export interface ObsRT {
  hp: number;
  maxHp: number;
  fallT: number;
  dirX: number;
  dirZ: number;
  landed: boolean;
}
export interface HazRT {
  state: number;
  t0: number;
  cool: [number, number];
}

const TOP: Record<RtPropKind, number> = { crate: 0.9, barrel: 1.0, urn: 0.7, rock: 0.75, explosive: 1.0, brazier: 1.2, lantern: 1.6, chunk: 0.6 };
const FRAGILE: Record<RtPropKind, boolean> = { crate: true, barrel: true, urn: true, rock: false, explosive: true, brazier: true, lantern: true, chunk: false };

export class World {
  L: ArenaLayout;
  props: PropRT[] = [];
  obs: ObsRT[];
  haz: HazRT[];
  /** analytics */
  stats = { pickups: 0, throws: 0, throwHits: 0, throwBlocked: 0, throwDodged: 0, batted: 0, topples: 0, crushHits: 0, explosions: 0, blastHits: 0, hazardHits: 0, coverHits: 0, propBreaks: 0, chandeliers: 0 };

  constructor(L: ArenaLayout) {
    this.L = L;
    for (const p of L.props)
      this.props.push({ id: p.id, kind: p.kind, x: p.x, y: 0, z: p.z, vx: 0, vy: 0, vz: 0, rot: (p.id * 2.39996) % (Math.PI * 2), spin: 0, r: p.r, hp: p.hp, maxHp: p.hp, mass: p.mass, throwable: p.throwable, explosive: p.explosive, state: PS_REST, carrier: -1, owner: -1, fuseAt: -1, top: TOP[p.kind] });
    this.obs = L.obstacles.map((o) => ({ hp: o.hp, maxHp: o.hp, fallT: -1, dirX: 0, dirZ: 0, landed: false }));
    this.haz = L.hazards.map(() => ({ state: 0, t0: -9, cool: [-9, -9] as [number, number] }));
  }

  /** standing (collidable / cover) obstacle? */
  standing(i: number) {
    return this.obs[i].fallT < 0;
  }

  /** Does the segment a->b pass through standing cover? */
  blocked(ax: number, az: number, bx: number, bz: number, pad = 0.15): boolean {
    const dx = bx - ax,
      dz = bz - az;
    const l2 = dx * dx + dz * dz || 1e-6;
    for (let i = 0; i < this.L.obstacles.length; i++) {
      if (!this.standing(i)) continue;
      const p = this.L.obstacles[i];
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
      if (hypot(ax + dx * t - p.x, az + dz * t - p.z) < p.r + pad) return true;
    }
    return false;
  }

  /** Signed distance (m) from (x,z) to the arena boundary at shrink scale s (positive = inside). */
  edgeGap(x: number, z: number, s = 1) {
    return boundR(this.L, x, z) * s - hypot(x, z);
  }

  // ------------------------------------------------------------------ damage entry points
  damageObstacle(m: Match, i: number, amount: number, fromX: number, fromZ: number, by: number) {
    const o = this.obs[i];
    const d = this.L.obstacles[i];
    if (o.fallT >= 0 || d.kind === 'rock') return;
    o.hp -= amount;
    this.stats.coverHits++;
    m.emit('cover_hit', by, -1, { obs: i, dmg: Math.round(amount), hp: +Math.max(0, o.hp / o.maxHp).toFixed(2) });
    if (o.hp <= 0) {
      o.hp = 0;
      let dx = d.x - fromX,
        dz = d.z - fromZ;
      const l = hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      o.fallT = m.t;
      o.dirX = dx;
      o.dirZ = dz;
      this.stats.topples++;
      m.emit('topple', by, -1, { obs: i, dx: +dx.toFixed(3), dz: +dz.toFixed(3), h: d.h, kind: d.kind });
    }
  }

  damageProp(m: Match, i: number, amount: number, by: number) {
    const p = this.props[i];
    if (p.state === PS_GONE || p.state === PS_CARRIED) return;
    if (p.kind === 'rock' || p.kind === 'chunk') return;
    p.hp -= amount;
    if (p.hp <= 0) this.breakProp(m, i, by);
  }

  breakProp(m: Match, i: number, by: number) {
    const p = this.props[i];
    if (p.state === PS_GONE) return;
    if (p.explosive) {
      if (p.fuseAt < 0) {
        p.fuseAt = m.t + (p.state === PS_FLYING ? 0 : 0.4);
        m.emit('fuse', by, -1, { prop: i });
      }
      if (p.state !== PS_FLYING) return;
      this.explode(m, i, by);
      return;
    }
    this.release(m, p);
    p.state = PS_GONE;
    p.hp = 0;
    this.stats.propBreaks++;
    m.emit('prop_break', by, -1, { prop: i, kind: p.kind, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
  }

  private release(m: Match, p: PropRT) {
    if (p.carrier >= 0) {
      const f = m.f[p.carrier];
      if (f.carry === p.id) f.carry = -1;
      if (f.liftProp === p.id) f.liftProp = -1;
      p.carrier = -1;
    }
  }

  explode(m: Match, i: number, by: number) {
    const p = this.props[i];
    if (p.state === PS_GONE) return;
    this.release(m, p);
    p.state = PS_GONE;
    p.hp = 0;
    p.fuseAt = -1;
    this.stats.explosions++;
    m.drama.spectacle(3);
    const R = 3.2;
    m.emit('explosion', by, -1, { prop: i, x: +p.x.toFixed(2), y: +Math.max(0.5, p.y).toFixed(2), z: +p.z.toFixed(2), r: R });
    for (const f of m.f) {
      if (f.state === 'dead') continue;
      const d = hypot(f.x - p.x, f.z - p.z) - f.def.stats.radius;
      if (d > R) continue;
      const k = 1 - Math.max(0, d) / R;
      const att = by >= 0 ? m.f[by] : m.f[1 - f.idx];
      const dmg = (20 + 55 * k) * m.drama.damageMul(att, f);
      this.stats.blastHits++;
      m.envHit(f, att === f ? m.f[1 - f.idx] : att, dmg, 'explosion', { x: p.x, z: p.z, kb: 8 * k + 3, knockdown: d < 2.0, lethal: true });
    }
    for (let j = 0; j < this.props.length; j++) {
      if (j === i) continue;
      const q = this.props[j];
      if (q.state === PS_GONE) continue;
      const d = hypot(q.x - p.x, q.z - p.z);
      if (d < R) {
        if (q.explosive && q.fuseAt < 0) {
          q.fuseAt = m.t + 0.18 + d * 0.05;
          m.emit('fuse', by, -1, { prop: j });
        } else if (!q.explosive) this.damageProp(m, j, 80, by);
      }
    }
    for (let j = 0; j < this.L.obstacles.length; j++) {
      const o = this.L.obstacles[j];
      const d = hypot(o.x - p.x, o.z - p.z) - o.r;
      if (d < R) this.damageObstacle(m, j, 110 * (1 - Math.max(0, d) / R), p.x, p.z, by);
    }
    this.shake(m, p.x, p.z, 6);
  }

  /** a big impact at (x,z) shakes loose hanging hazards nearby */
  shake(m: Match, x: number, z: number, radius: number) {
    for (let i = 0; i < this.L.hazards.length; i++) {
      const h = this.L.hazards[i];
      if (h.kind !== 'chandelier') continue;
      const s = this.haz[i];
      if (s.state !== 0) continue;
      if (hypot(h.x - x, h.z - z) < radius) {
        s.state = 1;
        s.t0 = m.t;
        m.emit('hazard_trigger', -1, -1, { haz: i, kind: h.kind });
      }
    }
  }

  // ------------------------------------------------------------------ fighter interaction
  /** Can f pick up prop i right now? */
  canLift(f: FighterState, i: number) {
    const p = this.props[i];
    if (!p || p.state !== PS_REST || !p.throwable || p.carrier >= 0 || p.fuseAt >= 0) return false;
    return hypot(p.x - f.x, p.z - f.z) <= f.def.stats.radius + p.r + 0.75;
  }

  reserve(f: FighterState, i: number) {
    this.props[i].carrier = f.idx;
    f.liftProp = i;
  }

  attach(m: Match, f: FighterState) {
    const i = f.liftProp;
    if (i < 0) return;
    const p = this.props[i];
    f.liftProp = -1;
    if (p.state !== PS_REST || p.carrier !== f.idx) return;
    p.state = PS_CARRIED;
    f.carry = i;
    this.stats.pickups++;
    m.emit('prop_pickup', f.idx, -1, { prop: i, kind: p.kind });
  }

  /** prop falls out of the carrier's hands */
  drop(m: Match, f: FighterState) {
    if (f.liftProp >= 0) {
      const p = this.props[f.liftProp];
      if (p.carrier === f.idx && p.state === PS_REST) p.carrier = -1;
      f.liftProp = -1;
    }
    if (f.carry < 0) return;
    const p = this.props[f.carry];
    f.carry = -1;
    p.carrier = -1;
    if (p.state !== PS_CARRIED) return;
    const fx = sin(f.facing),
      fz = cos(f.facing);
    p.state = PS_FLYING;
    p.owner = -1;
    p.x = f.x + fx * 0.5;
    p.z = f.z + fz * 0.5;
    p.y = 1.2;
    p.vx = fx * 1.2 + f.kx * 0.3;
    p.vz = fz * 1.2 + f.kz * 0.3;
    p.vy = 0.5;
    p.spin = 3;
    m.emit('prop_drop', f.idx, -1, { prop: p.id });
  }

  /** release the carried prop at the clip's release frame, aimed (with lead) at the target */
  launch(m: Match, f: FighterState, o: FighterState) {
    if (f.carry < 0) return;
    const p = this.props[f.carry];
    f.carry = -1;
    p.carrier = -1;
    const fx = sin(f.facing),
      fz = cos(f.facing);
    const sx = f.x + fx * 0.45,
      sz = f.z + fz * 0.45;
    const sy = f.def.id === 'maw' ? 2.0 : 1.75;
    const vh = 15.5 - 2.2 * p.mass;
    // lead: aim where the target will be, imperfectly (skill)
    let tx = o.x,
      tz = o.z;
    let T = hypot(tx - sx, tz - sz) / vh;
    tx += o.mx * T * 0.7;
    tz += o.mz * T * 0.7;
    T = hypot(tx - sx, tz - sz) / vh;
    let dir = atan2(tx - sx, tz - sz);
    dir += m.rng.gauss() * 0.045 * (1.25 - f.def.stats.skill);
    // keep the release within a cone of where the body faces
    const off = Math.max(-0.5, Math.min(0.5, angDiff(f.facing, dir)));
    dir = f.facing + off;
    const ty = 1.15;
    const vy = (ty - sy + 0.5 * G * T * T) / Math.max(0.08, T);
    p.state = PS_FLYING;
    p.owner = f.idx;
    p.x = sx;
    p.y = sy;
    p.z = sz;
    p.vx = sin(dir) * vh;
    p.vz = cos(dir) * vh;
    p.vy = vy;
    p.spin = 7 * (m.rng.chance(0.5) ? 1 : -1);
    this.stats.throws++;
    m.emit('prop_throw', f.idx, o.idx, { prop: p.id, kind: p.kind, mass: p.mass });
  }

  // ------------------------------------------------------------------ per-tick
  update(m: Match, dt: number) {
    const t = m.t;
    // carried props ride along (render puts them in the hands)
    for (const p of this.props) {
      if (p.state === PS_CARRIED && p.carrier >= 0) {
        const f = m.f[p.carrier];
        p.x = f.x;
        p.z = f.z;
        p.y = 1.3;
        p.rot = f.facing;
      }
    }
    // fuses
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.fuseAt >= 0 && t >= p.fuseAt && p.state !== PS_GONE) {
        // a lit barrel that's being carried blows up in the carrier's hands
        this.explode(m, i, p.owner >= 0 ? p.owner : -1);
      }
    }
    // flying props
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.state !== PS_FLYING) continue;
      const ox = p.x,
        oy = p.y,
        oz = p.z;
      p.vy -= G * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
      // swept contact vs the target (thrown props only)
      if (p.owner >= 0 && !m.over) {
        const def = m.f[1 - p.owner];
        if (def.state !== 'dead' && this.flightVsFighter(m, i, def, ox, oy, oz)) continue;
      }
      // standing cover
      let hitObs = -1;
      for (let j = 0; j < this.L.obstacles.length; j++) {
        if (!this.standing(j)) continue;
        const o = this.L.obstacles[j];
        if (p.y < o.h && hypot(p.x - o.x, p.z - o.z) < o.r + p.r * 0.8) {
          hitObs = j;
          break;
        }
      }
      if (hitObs >= 0) {
        if (p.owner >= 0) this.damageObstacle(m, hitObs, 22 * p.mass, ox, oz, p.owner);
        this.impact(m, i, p.owner);
        continue;
      }
      if (this.edgeGap(p.x, p.z) < -0.3) {
        this.impact(m, i, p.owner);
        continue;
      }
      if (p.y <= p.r * 0.6) {
        p.y = 0;
        if (p.owner >= 0 && (FRAGILE[p.kind] || p.explosive)) this.impact(m, i, p.owner);
        else {
          // rocks / chunks / dropped props settle
          p.state = PS_REST;
          p.vx = p.vy = p.vz = 0;
          p.spin = 0;
          p.owner = -1;
          m.emit('prop_land', -1, -1, { prop: i, kind: p.kind, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
        }
      }
    }
    // toppling obstacles land
    for (let i = 0; i < this.obs.length; i++) {
      const o = this.obs[i];
      if (o.fallT < 0 || o.landed || t - o.fallT < TOPPLE_FALL) continue;
      o.landed = true;
      this.landColumn(m, i);
    }
    // hazards
    for (let i = 0; i < this.L.hazards.length; i++) this.updateHazard(m, i, dt);
  }

  private flightVsFighter(m: Match, i: number, def: FighterState, ox: number, oy: number, oz: number): boolean {
    const p = this.props[i];
    const att = m.f[p.owner];
    // swatted out of the air by an active melee swing aimed at it
    if (def.state === 'attack' && def.move && !def.move.ranged && m.attackPhase(def) === 1 && p.y < 2.6) {
      const dx = p.x - def.x,
        dz = p.z - def.z;
      const d = hypot(dx, dz);
      const a = Math.abs(angDiff(def.facing, atan2(dx, dz)));
      if (d < def.def.stats.radius + 1.3 && a < 1.2) {
        this.stats.batted++;
        m.emit('prop_batted', def.idx, att.idx, { prop: i, kind: p.kind });
        if (p.explosive) this.explode(m, i, def.idx);
        else this.breakProp(m, i, def.idx);
        return true;
      }
    }
    const cap = m.capsuleOf(def);
    const g = segSegDist([ox, oy, oz], [p.x, p.y, p.z], cap.a, cap.b) - cap.r - p.r * 0.85;
    if (g > 0) return false;
    if (m.isInvulnerable(def)) {
      if (def.state === 'dodge') {
        this.stats.throwDodged++;
        m.emit('dodge', def.idx, att.idx, { move: 'thrown' });
      }
      return false; // passes through the roll
    }
    m.contactLog.push(g);
    if (p.explosive) {
      this.explode(m, i, att.idx);
      return true;
    }
    const toAtt = atan2(-p.vx, -p.vz);
    const frontal = Math.abs(angDiff(def.facing, toAtt)) < 1.4;
    if (def.state === 'block' && frontal) {
      this.stats.throwBlocked++;
      const chip = (6 + 6 * p.mass) * (1 - def.def.stats.blockStrength * 0.6);
      def.stamina -= 14 * p.mass * (1.25 - def.def.stats.blockStrength);
      def.kx += p.vx * 0.12;
      def.kz += p.vz * 0.12;
      m.emit('block', def.idx, att.idx, { move: 'thrown', chip: Math.round(chip) });
      m.applyDamage(def, chip, att, 'thrown', false);
      if (def.stamina <= 0 && !m.isDead(def)) {
        def.stamina = 0;
        m.setState(def, 'stagger', 1.0);
        m.emit('guard_break', def.idx, att.idx, { move: 'thrown' });
      }
      this.impact(m, i, att.idx);
      return true;
    }
    this.stats.throwHits++;
    const dmg = (22 + 20 * p.mass) * att.buffMul * m.drama.damageMul(att, def);
    const sp = hypot(p.vx, p.vz) || 1;
    m.emit('prop_hit', att.idx, def.idx, { prop: i, kind: p.kind, dmg: Math.round(dmg), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
    att.hitsLanded++;
    m.envHit(def, att, dmg, `thrown ${p.kind}`, { x: def.x - p.vx / sp, z: def.z - p.vz / sp, kb: 2.5 + p.mass * 1.6, knockdown: p.mass >= 1.5, lethal: true, hitEvent: true });
    if (FRAGILE[p.kind]) this.breakProp(m, i, att.idx);
    else {
      // rocks drop at the victim's feet
      p.vx *= -0.15;
      p.vz *= -0.15;
      p.vy = 1;
      p.owner = -1;
    }
    return true;
  }

  private impact(m: Match, i: number, by: number) {
    const p = this.props[i];
    if (p.explosive) {
      this.explode(m, i, by);
      return;
    }
    if (FRAGILE[p.kind]) {
      this.breakProp(m, i, by);
      return;
    }
    p.state = PS_REST;
    p.y = 0;
    p.vx = p.vy = p.vz = 0;
    p.spin = 0;
    p.owner = -1;
    // pull back inside the arena if it hit the wall
    const g = this.edgeGap(p.x, p.z);
    if (g < 0.6) {
      const r = hypot(p.x, p.z) || 1;
      const k = (r + g - 0.6) / r;
      p.x *= k;
      p.z *= k;
    }
    m.emit('prop_land', -1, -1, { prop: i, kind: p.kind, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }

  private landColumn(m: Match, i: number) {
    const d = this.L.obstacles[i];
    const o = this.obs[i];
    const ax = d.x,
      az = d.z;
    const bx = d.x + o.dirX * d.h,
      bz = d.z + o.dirZ * d.h;
    m.emit('topple_impact', -1, -1, { obs: i, x: +((ax + bx) / 2).toFixed(2), z: +((az + bz) / 2).toFixed(2) });
    m.drama.spectacle(3);
    for (const f of m.f) {
      if (f.state === 'dead') continue;
      const dist = segPointDist(ax, az, bx, bz, f.x, f.z);
      if (dist > f.def.stats.radius + d.r * 0.75) continue;
      // knocked sideways out from under the column
      const t = clampN(((f.x - ax) * (bx - ax) + (f.z - az) * (bz - az)) / (d.h * d.h), 0, 1);
      const cx = ax + (bx - ax) * t,
        cz = az + (bz - az) * t;
      const att = m.f[1 - f.idx];
      this.stats.crushHits++;
      m.emit('crush', att.idx, f.idx, { obs: i });
      m.envHit(f, att, 48 * m.drama.damageMul(att, f), 'falling ' + d.kind, { x: cx, z: cz, kb: 5, knockdown: true, lethal: true });
    }
    // props under it break
    for (let j = 0; j < this.props.length; j++) {
      const p = this.props[j];
      if (p.state !== PS_REST) continue;
      if (segPointDist(ax, az, bx, bz, p.x, p.z) < p.r + d.r * 0.7) this.damageProp(m, j, 999, -1);
    }
    // rubble: throwable chunks along the fall line
    for (const k of [0.45, 0.8]) {
      let x = ax + (bx - ax) * k + -o.dirZ * 0.35,
        z = az + (bz - az) * k + o.dirX * 0.35;
      const g = this.edgeGap(x, z);
      if (g < 0.8) {
        const r = hypot(x, z) || 1;
        x *= (r + g - 0.8) / r;
        z *= (r + g - 0.8) / r;
      }
      this.props.push({ id: this.props.length, kind: 'chunk', x, y: 0, z, vx: 0, vy: 0, vz: 0, rot: k * 4 + i, spin: 0, r: 0.38, hp: 999, maxHp: 999, mass: 1.4, throwable: true, explosive: false, state: PS_REST, carrier: -1, owner: -1, fuseAt: -1, top: TOP.chunk });
    }
    this.shake(m, (ax + bx) / 2, (az + bz) / 2, 7);
  }

  /** hazard state for AI / render: is (x,z) dangerous right now? (0 = safe) */
  danger(m: Match, x: number, z: number, pad = 0.6): number {
    let d = 0;
    for (let i = 0; i < this.L.hazards.length; i++) {
      const h = this.L.hazards[i];
      const s = this.haz[i];
      const dist = hypot(x - h.x, z - h.z) - h.r;
      if (dist > pad) continue;
      const w = 1 - Math.max(0, dist) / pad;
      switch (h.kind) {
        case 'lava':
          d += 3 * Math.max(w, dist < 0 ? 1 : 0);
          break;
        case 'firepit':
          d += 2 * Math.max(w, dist < 0 ? 1 : 0);
          break;
        case 'spikes':
          d += s.state === 1 || s.state === 2 ? 2 : 0.35;
          break;
        case 'geyser':
          d += s.state >= 1 ? 2 : 0.5;
          break;
        case 'chandelier':
          d += s.state === 1 || s.state === 2 ? 2.5 : 0.2;
          break;
        case 'water':
          d += 0.25;
          break;
      }
    }
    for (const p of this.props) {
      if (p.fuseAt >= 0 && p.state !== PS_GONE && hypot(x - p.x, z - p.z) < 3.6) d += 3;
    }
    return d;
  }

  slowAt(x: number, z: number): number {
    for (const h of this.L.hazards) if (h.kind === 'water' && hypot(x - h.x, z - h.z) < h.r) return 0.68;
    return 1;
  }

  private updateHazard(m: Match, i: number, dt: number) {
    const h = this.L.hazards[i];
    const s = this.haz[i];
    const t = m.t;
    const inside = (f: FighterState, pad = 0) => f.state !== 'dead' && f.state !== 'launched' && hypot(f.x - h.x, f.z - h.z) < h.r + pad;
    switch (h.kind) {
      case 'lava':
      case 'firepit': {
        for (const f of m.f) {
          if (!inside(f, -0.15) || t < s.cool[f.idx] || m.over) continue;
          s.cool[f.idx] = t + 1.1;
          const att = m.f[1 - f.idx];
          const lava = h.kind === 'lava';
          this.stats.hazardHits++;
          m.emit('hazard_hit', att.idx, f.idx, { haz: i, kind: h.kind });
          // pop out of the pool (burst damage; the fall in is what hurts)
          m.envHit(f, att, (lava ? 30 : 18) * m.drama.damageMul(att, f), h.kind, { x: h.x, z: h.z, kb: 6.5, knockdown: false, lethal: true, minKb: true });
        }
        break;
      }
      case 'spikes': {
        if (s.state === 0) {
          if (m.f.some((f) => inside(f))) {
            s.state = 1;
            s.t0 = t;
            m.emit('hazard_trigger', -1, -1, { haz: i, kind: h.kind });
          }
        } else if (s.state === 1 && t - s.t0 >= 0.45) {
          s.state = 2;
          s.t0 = t;
          for (const f of m.f) {
            if (!inside(f, 0.1) || m.over) continue;
            const att = m.f[1 - f.idx];
            this.stats.hazardHits++;
            m.emit('hazard_hit', att.idx, f.idx, { haz: i, kind: h.kind });
            m.envHit(f, att, 26 * m.drama.damageMul(att, f), 'spike trap', { x: h.x, z: h.z, kb: 3, knockdown: f.state === 'stagger', lethal: true });
          }
        } else if (s.state === 2 && t - s.t0 >= 0.7) {
          s.state = 3;
          s.t0 = t;
        } else if (s.state === 3 && t - s.t0 >= 2.2) s.state = 0;
        break;
      }
      case 'geyser': {
        const per = h.period;
        const ph = (t + h.phase) % per;
        const ns = ph < per - 2.0 ? 0 : ph < per - 0.8 ? 1 : 2;
        if (ns === 2 && s.state !== 2) {
          for (const f of m.f) {
            if (!inside(f, 0.1) || m.over) continue;
            const att = m.f[1 - f.idx];
            this.stats.hazardHits++;
            m.emit('hazard_hit', att.idx, f.idx, { haz: i, kind: h.kind });
            m.envHit(f, att, 24 * m.drama.damageMul(att, f), 'geyser', { x: h.x, z: h.z, kb: 4, knockdown: true, lethal: true });
          }
        }
        if (ns === 1 && s.state === 0) m.emit('hazard_trigger', -1, -1, { haz: i, kind: h.kind });
        s.state = ns;
        break;
      }
      case 'chandelier': {
        if (s.state === 1 && t - s.t0 >= 0.9) {
          s.state = 2;
          s.t0 = t;
          this.stats.chandeliers++;
          m.emit('chandelier_fall', -1, -1, { haz: i });
        } else if (s.state === 2 && t - s.t0 >= 0.55) {
          s.state = 3;
          s.t0 = t;
          m.emit('chandelier_impact', -1, -1, { haz: i, x: h.x, z: h.z });
          m.drama.spectacle(2.5);
          for (const f of m.f) {
            if (!inside(f, f.def.stats.radius) || m.over) continue;
            const att = m.f[1 - f.idx];
            this.stats.hazardHits++;
            m.emit('hazard_hit', att.idx, f.idx, { haz: i, kind: h.kind });
            m.envHit(f, att, 50 * m.drama.damageMul(att, f), 'chandelier', { x: h.x, z: h.z, kb: 4, knockdown: true, lethal: true });
          }
          for (let j = 0; j < this.props.length; j++) {
            const p = this.props[j];
            if (p.state === PS_REST && hypot(p.x - h.x, p.z - h.z) < h.r) this.damageProp(m, j, 999, -1);
          }
        }
        break;
      }
    }
    void dt;
  }

  /** compact per-frame snapshot for playback */
  snapshot(): { props: Float32Array; obs: Float32Array; haz: Uint8Array } {
    const props = new Float32Array(this.props.length * 6);
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      props.set([p.x, p.y, p.z, p.state + (p.fuseAt >= 0 ? 10 : 0), p.hp / p.maxHp, p.rot], i * 6);
    }
    const obs = new Float32Array(this.obs.length);
    for (let i = 0; i < this.obs.length; i++) obs[i] = this.obs[i].fallT >= 0 ? -1 - this.obs[i].fallT : this.obs[i].hp / this.obs[i].maxHp;
    const haz = new Uint8Array(this.haz.length);
    for (let i = 0; i < this.haz.length; i++) haz[i] = this.haz[i].state;
    return { props, obs, haz };
  }
}

export function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const clampN = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export function segPointDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax,
    dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-6;
  const t = clampN(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  return hypot(ax + dx * t - px, az + dz * t - pz);
}
