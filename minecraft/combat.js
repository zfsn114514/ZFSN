/* ── 战斗核心（纯逻辑层，与渲染无关，可被 Node 单测）─────────────
 *
 * 这个文件不依赖 document / canvas / World，所有函数都操作「活体实体状态对象」
 * （普通 JS 对象，字段见下方 LivingEntity 注释），方便写单元测试覆盖
 * 第 2~7、10 节的每一条规则。
 *
 * 实体状态对象约定字段（缺省即视为 0 / false）：
 *   health, maxHealth, absorption, hurtTime(0~10), invulnerableTicks,
 *   lastDamage, knockbackResistance, deathTime(0~20), armor, armorToughness,
 *   onFire, food, saturation, exhaustion, x, y, vx, vy, ground, face
 * 玩家额外：creative(布尔)
 */
import * as C from './config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const COMBAT_VERSION = C.COMBAT_VERSION;

/* ── 武器数值 ─────────────────────────────────────────────────── */
function materialOf(id) {
  if (!id) return 'wood';
  const m = String(id).match(/^(wooden|stone|iron|diamond|golden|gold|netherite)_/);
  if (!m) return 'wood';
  return { wooden: 'wood', golden: 'gold' }[m[1]] ?? m[1];
}
/** 取一件物品的攻击数值。item 可以是 {attackDamage,attackSpeed}（测试直接给），
 *  也可以是带 tool/id 的 ITEMS 条目（运行时由 game.js 传入）。 */
export function weaponStats(item) {
  if (item && Number.isFinite(item.attackDamage)) {
    return { attackDamage: item.attackDamage, attackSpeed: item.attackSpeed ?? C.HAND_SPEED };
  }
  if (!item || !item.tool) return { attackDamage: C.HAND_DAMAGE, attackSpeed: C.HAND_SPEED };
  const mat = materialOf(item.id);
  const d = C.WEAPON_DAMAGE[item.tool]?.[mat];
  if (d == null) return { attackDamage: C.HAND_DAMAGE, attackSpeed: C.HAND_SPEED };
  let s = C.WEAPON_SPEED[item.tool];
  if (typeof s === 'object') s = s[mat] ?? C.HAND_SPEED;
  return { attackDamage: d, attackSpeed: s };
}
/** 攻击冷却总时长（tick）。 */
export function cooldownTicks(attackSpeed) { return 20 / attackSpeed; }
/** 攻击强度 0~1。 */
export function meleeStrength(ticksSince, cd) {
  if (!cd) return 1;
  return clamp((ticksSince + 0.5) / cd, 0, 1);
}
/** 实际近战伤害。crit 额外 ×1.5。 */
export function meleeDamage(base, strength, crit) {
  let d = base * (0.2 + strength * strength * 0.8);
  if (crit) d *= 1.5;
  return d;
}
/** 暴击：strength>0.9、在空中且正在下落(vy<0)、不在水中/梯子上、未疾跑。 */
export function isCrit({ strength, airborne, vy, inWater, onLadder, sprinting }) {
  return strength > 0.9 && !!airborne && vy < 0 && !inWater && !onLadder && !sprinting;
}
/** 横扫（仅剑）：strength>0.9、在地面、未疾跑、本次不是暴击。 */
export function isSweep({ strength, onGround, sprinting, crit, weaponIsSword }) {
  return !!weaponIsSword && strength > 0.9 && !!onGround && !sprinting && !crit;
}
/** 横扫命中判定：主目标周围「水平 1 格内」的其它生物。
 *  ★ 提示词原文：「主目标周围水平 1 格内的其他生物受到 1 点伤害并带轻微击退」。
 *    —— 以「主目标」为圆心，只比水平距离，不比垂直距离
 *      （2D 里垂直距离就是屏幕上下，原版横扫也是一圈水平范围）。
 *  mobs 是全部生物，main 是主目标（要排除），cx 是主目标的水平中心。 */
export function sweepTargets(mobs, main, cx, radius = C.SWEEP_RADIUS) {
  const out = [];
  for (const m of mobs) {
    if (!m || m === main || (m.health ?? 0) <= 0) continue;
    if (m.dying) continue;
    const dx = Math.abs((m.x + (m.w ?? 0) / 2) - cx);
    /* ★ 加一点容差：中心正好差 1 格时，浮点误差会让 1.0 变成 1.0000000000000004，
       明明「1 格内」却被判成「1格外」。 */
    if (dx <= radius + 1e-6) out.push(m);
  }
  return out;
}
/** 疾跑攻击的结算：命中后取消疾跑，玩家水平速度 ×0.6（原版疾跑攻击后的减速）。 */
export function sprintAttackEffect(player, scale = C.SPRINT_ATTACK_SPEED_SCALE) {
  if (!player.sprinting) return { sprinting: player.sprinting, vx: player.vx ?? 0 };
  player.sprinting = false;
  player.vx = (player.vx ?? 0) * scale;
  return { sprinting: false, vx: player.vx };
}

/* ── 护甲 ─────────────────────────────────────────────────────── */
export function armorMaterialOf(id) {
  const m = String(id).match(/^(leather|chainmail|golden|gold|iron|diamond|netherite|turtle)_/);
  return m ? (m[1] === 'golden' ? 'gold' : m[1]) : null;
}
/** 取实体身上的「护甲点数」。
 *  ★ 玩家身上同时有两个 armor 字段：armor 是 {helmet,chestplate,...} 装备字典，
 *    armorPoints 才是数值。生物只有数值 armor。两个都要兼容，否则会把
 *    字典当数字算 → NaN 伤害。 */
export function armorPointsOf(e) {
  if (Number.isFinite(e?.armorPoints)) return e.armorPoints;
  if (Number.isFinite(e?.armor)) return e.armor;
  return 0;
}
/** 取实体身上的击退抗性：自身抗性 + 护甲抗性（下界合金 0.1/件）。 */
export function knockbackResistanceOf(e) {
  return (e?.knockbackResistance ?? 0) + (e?.armorKBR ?? 0);
}
/** 由 {helmet,chestplate,leggings,boots} 算出合计点数 / 韧性 / 击退抗性。 */
export function armorStats(armorObj) {
  let points = 0, toughness = 0, kbr = 0;
  if (armorObj) for (const part of ['helmet', 'chestplate', 'leggings', 'boots']) {
    const s = armorObj[part];
    if (!s) continue;
    const mat = armorMaterialOf(s.id);
    if (!mat) continue;
    points += C.ARMOR_SLOT_POINTS[mat]?.[part] ?? 0;
    toughness += C.ARMOR_TOUGHNESS[mat] ?? 0;
    kbr += C.ARMOR_KBR[mat] ?? 0;
  }
  return { points, toughness, kbr };
}
/** 护甲减伤：reduction = min(20, max(armor/5, armor - dmg/(2+tough/4)))/25。 */
export function armorReduction(armor, toughness, damage) {
  const epf = Math.min(20, Math.max(armor / 5, armor - damage / (2 + (toughness || 0) / 4)));
  const reduction = epf / 25;
  return { reduction, finalDamage: damage * (1 - reduction), reduced: damage * reduction };
}

/* ── 击退 ─────────────────────────────────────────────────────── */
/** 计算受击者的新速度。水平：先 ×0.5 再按方向加 kbStrength；
 *  垂直：在地面则 vy=min(0.4, vy/2+0.4)，否则不变；最后整体乘 (1-kbr)。
 *  kbStrength 可显式指定推力（横扫的「轻微击退」用 0.15）。 */
export function knockback(target, { attackerX, sprint = false, kbLevel = 0, kbr, kbStrength }) {
  const dir = (target.x >= attackerX) ? 1 : -1;
  const kb = kbStrength ?? (C.KNOCKBACK_BASE + (sprint ? C.KNOCKBACK_SPRINT_BONUS : 0) + kbLevel * C.KNOCKBACK_PER_LEVEL);
  const vx = (target.vx ?? 0) * 0.5 + dir * kb;
  let vy = target.vy ?? 0;
  if (target.ground) vy = Math.min(0.4, vy / 2 + 0.4);
  const res = kbr ?? knockbackResistanceOf(target);
  const f = 1 - res;
  return { vx: vx * f, vy: vy * f, dir };
}

/* ── 统一伤害管线 ─────────────────────────────────────────────── */
/** 所有伤害走这一个入口。
 *  opts: { type, bypassArmor, blocked, shieldKnockback, peacefulHostile,
 *          difficulty, void }
 *  返回 { ignored, dealt, healthDamage, absorbed, armorWore, blocked,
 *          partial, triggeredKnockback, died } */
export function hurt(e, amount, opts = {}) {
  const difficulty = opts.difficulty ?? C.DEFAULT_DIFFICULTY;
  // 1) 已死亡 / 创造或旁观（虚空与 /kill 除外）/ 和平下的敌对伤害 → 忽略
  if ((e.health ?? 0) <= 0) return { ignored: true };
  if (e.creative && !opts.void) return { ignored: true };
  if (opts.peacefulHostile && difficulty === 'peaceful' && !opts.void) return { ignored: true };

  // 2) 无敌帧
  if ((e.invulnerableTicks ?? 0) > 0) {
    if (e.invulnerableTicks > 10) {
      // 前 10 tick：只有更大的伤害才生效，只补差值，不触发击退/动画
      if (amount <= (e.lastDamage ?? 0)) return { ignored: true, partial: false };
      const diff = amount - (e.lastDamage ?? 0);
      e.lastDamage = amount;
      e.health = Math.max(0, (e.health ?? 0) - diff);
      return { dealt: diff, healthDamage: diff, absorbed: 0, armorWore: false, blocked: false, partial: true, triggeredKnockback: false, died: (e.health ?? 0) <= 0 };
    }
    // invuln<=10：走正常判定
  }

  // 3) 盾牌格挡：伤害归零并触发盾牌效果（击退由调用方在 blocked 时另算）
  if (opts.blocked) {
    e.invulnerableTicks = 20;
    e.lastDamage = amount;
    e.hurtTime = 10;
    return { dealt: 0, healthDamage: 0, absorbed: 0, armorWore: false, blocked: true, triggeredKnockback: !!opts.shieldKnockback, died: false };
  }

  // 4) 护甲减伤
  let dmg = amount, armorWore = false;
  if (!opts.bypassArmor) {
    const r = armorReduction(armorPointsOf(e), e.armorToughness ?? 0, dmg);
    dmg = r.finalDamage;
    armorWore = r.reduced > 0;
  }
  // 5) 吸收
  let absorbed = 0;
  if ((e.absorption ?? 0) > 0) {
    const a = Math.min(e.absorption, dmg);
    e.absorption -= a; dmg -= a; absorbed = a;
  }
  // 6) 扣血
  const before = e.health ?? 0;
  e.health = Math.max(0, before - dmg);
  e.invulnerableTicks = 20;
  if (amount > 0) e.lastDamage = amount;
  e.hurtTime = 10;
  return {
    dealt: (before - e.health) + absorbed, healthDamage: before - e.health,
    absorbed, armorWore, blocked: false, partial: false, triggeredKnockback: true,
    died: (e.health ?? 0) <= 0,
  };
}
/** 每 tick（逻辑帧）递减无敌帧 / 受击红闪计时。单位都是 tick，每次调用减 1。 */
export function tickHurt(e) {
  if (e.invulnerableTicks > 0) e.invulnerableTicks = Math.max(0, e.invulnerableTicks - 1);
  if (e.hurtTime > 0) e.hurtTime = Math.max(0, e.hurtTime - 1);
  if (e.deathTime > 0 && (e.health ?? 0) <= 0) e.deathTime = Math.min(20, e.deathTime + 1);
}

/* ── 环境伤害公式 ─────────────────────────────────────────────── */
export function fallDamage(dist) {
  return dist > C.FALL_SAFE_DISTANCE ? Math.ceil(dist - C.FALL_SAFE_DISTANCE) : 0;
}

/* ── 护甲耐久磨损（section 6） ───────────────────────────────── */
/** 每件穿戴的护甲磨 max(1, floor(damage/4))。返回需要磨的件数信息供调用方写回。 */
export function armorWearAmount(damage) { return Math.max(1, Math.floor(damage / 4)); }

/* ── 饥饿 / 自然恢复 / 食物（section 7） ─────────────────────── */
/** 累加消耗度，满 4 档则先扣饱和再扣饥饿。 */
export function addExhaustion(p, amount) { p.exhaustion = (p.exhaustion || 0) + amount; }
export function consumeExhaustion(p) {
  let changed = false;
  while ((p.exhaustion || 0) >= 4) {
    p.exhaustion -= 4;
    if ((p.saturation || 0) > 0) p.saturation -= 1;
    else if ((p.food || 0) > 0) p.food = Math.max(0, p.food - 1);
    changed = true;
  }
  return changed;
}
/** 自然恢复计划：返回 {interval, exhaustion, saturation} 或 null（不恢复）。
 *  ★ 提示词第 7 节：饥饿 ≥18 → 每 80 tick 回 1，消耗度 6.0；
 *    饥饿 =20 且饱和 >0 → 每 10 tick 回 1，且「按饱和度消耗」
 *    （快速恢复消耗的是饱食度本身，不是消耗度 —— 饱和度耗尽就退回慢速恢复）。 */
export function regenPlan(p) {
  if (p.food === 20 && (p.saturation || 0) > 0)
    return { interval: C.REGEN_FAST_INTERVAL_TICKS, exhaustion: 0, saturation: C.REGEN_FAST_SATURATION_COST };
  if ((p.food || 0) >= C.REGEN_HUNGER_THRESHOLD)
    return { interval: C.REGEN_INTERVAL_TICKS, exhaustion: C.REGEN_EXHAUSTION_COST, saturation: 0 };
  return null;
}
/** 饥饿 ≤ 0 时每 80 tick 的 1 点伤害下限（半心）。 */
export function starveFloor(difficulty) { return C.DIFFICULTY_STARVE_FLOOR[difficulty] ?? 1; }
/** 饥饿伤害：每 STARVE_INTERVAL_TICKS 掉 1 点（半心），但血量不会掉到难度下限以下。
 *  ★ 下限是「血量下限」不是「伤害数值」：
 *    peaceful 20 / easy 10 / normal 1 / hard 0（困难可致死）。
 *    饥饿伤害按原版属于魔法伤害，不被护甲减免。 */
export function starveDamage(e, difficulty = C.DEFAULT_DIFFICULTY) {
  const floor = starveFloor(difficulty);
  if ((e.health ?? 0) <= floor) return 0;      // 已经到下限，不再掉血
  return 1;
}
/** 进食：返回是否成功（饥饿满时金苹果仍可吃）。 */
export function canEat(p, isGoldenApple = false) {
  return isGoldenApple || (p.food ?? 0) < 20;
}
/** 进食后写入饥饿/饱和度（数值取自 FOODS）。 */
export function applyFood(p, food, saturation, { absorption = 0 } = {}) {
  if (!canEat(p, absorption > 0)) return false;
  p.food = Math.min(20, (p.food || 0) + food);
  p.saturation = Math.min(20, (p.saturation || 0) + saturation);
  if (absorption > 0) p.absorption = Math.max(p.absorption || 0, absorption);
  return true;
}

/* ── 盾牌（section 10.2） ─────────────────────────────────────── */
/** 是否挡住。raised 且举起满 5 tick，且攻击来自玩家朝向一侧（前方 180°）。
 *  type 为 explosion/fall/void/magic 等绕过护甲的伤害 → 不挡。 */
export function shieldBlocks({ raised, raisedTicks, facing, attackerSide, type, bypassShield = false }) {
  if (bypassShield) return false;
  if (!raised || (raisedTicks ?? 0) < C.SHIELD_RAISE_TICKS) return false;
  if (type === 'melee' || type === 'projectile') return attackerSide === facing;
  return false;
}
export function shieldDurabilityLoss(blockedDamage) {
  return C.SHIELD_DURABILITY_PER_DAMAGE + Math.floor(blockedDamage);
}

/* ── 弓（section 10.1） ───────────────────────────────────────── */
/** 蓄力 t(0~1) → 速度（格/tick）。
 *  ★ 提示词里 `speed=(t²+2t)/3` 与「满蓄力 3.0」自相矛盾（t=1 时 (1+2)/3=1）。
 *   以具体数值锚点为准：满蓄力 = ARROW_SPEED_AT_FULL(3.0)，形状取 (t²+2t)。
 *   即 arrowSpeed = t²+2t（t=0→0，t=1→3），再乘 ARROW_SPEED_SCALE。 */
export function arrowSpeed(t) {
  return Math.min(C.ARROW_SPEED_AT_FULL, (t * t + 2 * t)) * C.ARROW_SPEED_SCALE;
}
/** 箭伤害 = ceil(speed×2)；满蓄力暴击箭额外随机加伤害由调用方处理。 */
export function arrowDamage(t) {
  const speed = arrowSpeed(t) / C.ARROW_SPEED_SCALE; // 去掉缩放还原原版速度
  return Math.max(1, Math.ceil(speed * 2));
}
/** 满蓄力「暴击箭」的额外随机伤害（提示词第 10 节）。 */
export function bowCritExtraDamage(rand = Math.random) {
  const span = C.BOW_CRIT_EXTRA_MAX - C.BOW_CRIT_EXTRA_MIN + 1;
  return C.BOW_CRIT_EXTRA_MIN + Math.floor(rand() * span);
}

/* ── 敌对生物生成条件（第 9 节） ──────────────────────────────── */
/** 能否生成敌对生物：光照等级 ≤ 7 且距玩家 24 格外。 */
export function canSpawnHostile(lightLevel, distance) {
  return lightLevel <= C.HOSTILE_SPAWN_LIGHT && distance > C.HOSTILE_SPAWN_MIN_DISTANCE;
}
/** 敌对生物是否应当消失：超过 128 格必定消失；32 格外按概率随机消失。 */
export function shouldDespawnHostile(distance, rand = Math.random) {
  if (distance > C.HOSTILE_DESPAWN_DISTANCE) return true;
  if (distance > C.HOSTILE_RANDOM_DESPAWN) return rand() < 0.5;
  return false;
}

/* ── 死亡 / 重生（section 11） ────────────────────────────────── */
export function xpOnDeath(level) { return Math.min(level * 7, 100); }
export function mobXp(hostile) {
  if (!hostile) { const [a, b] = C.MOB_XP.passive; return a + Math.floor(Math.random() * (b - a + 1)); }
  return C.MOB_XP.hostile;
}
/** 生物掉落表：按提示词第 9 节的区间随机。
 *  rand 传 ()=>[0,1) 的随机函数（测试里可注入确定值）。
 *  opts.burned=true 时把生肉换成熟肉（提示词「着火致死掉落熟肉」）。 */
export function mobDrops(type, rand = Math.random, opts = {}) {
  const table = C.MOB_DROPS[type];
  if (!table) return [];
  const out = [];
  for (const [id, min, max] of table) {
    const n = min + Math.floor(rand() * (max - min + 1));
    if (n > 0) out.push([opts.burned ? (C.COOKED_MEAT[id] ?? id) : id, n]);
  }
  return out;
}
/** 骷髅的射击间隔：在 [min,max] tick 之间随机（提示词：每 20~40 tick 一发）。 */
export function shootInterval(rand = Math.random) {
  const span = C.SKELETON_SHOOT_MAX_TICKS - C.SKELETON_SHOOT_MIN_TICKS + 1;
  return C.SKELETON_SHOOT_MIN_TICKS + Math.floor(rand() * span);
}

/* ── 火焰 / 窒息 / 仙人掌（section 8 环境伤害） ──────────────── */
/** 着火状态推进：返回本 tick 是否该扣血。
 *  ★ 火焰伤害绕过护甲（原版火焰是「魔法/环境」类伤害，提示词第 2 节）。 */
export function fireDamageTick(e) {
  if ((e.onFire ?? 0) <= 0) { e.fireTimer = 0; return false; }
  e.onFire--;
  e.fireTimer = (e.fireTimer ?? 0) + 1;
  if (e.fireTimer >= C.FIRE_TICK_INTERVAL) { e.fireTimer = 0; return true; }
  return false;
}
/** 窒息：头部卡在实心方块里 → 每 SUFFOCATE_INTERVAL_TICKS 扣 1 点（绕过护甲）。 */
export function suffocateDamageTick(e) {
  e.suffocateTimer = (e.suffocateTimer ?? 0) + 1;
  if (e.suffocateTimer >= C.SUFFOCATE_INTERVAL_TICKS) { e.suffocateTimer = 0; return true; }
  return false;
}

/* ── 经验（section 11） ──────────────────────────────────────── */
/** 升到下一级所需经验（原版公式：0~15 级 7+2L，16~30 级 17+3(L-16)，31 级以上 7+2(L-31)）。 */
export function xpToNext(level) {
  if (level >= 31) return 7 + 2 * (level - 31);
  if (level >= 16) return 17 + 3 * (level - 16);
  return 7 + 2 * level;
}
/** 拾取经验并处理升级。返回升级次数。 */
export function applyXp(p, amount) {
  p.xp = (p.xp || 0) + amount;
  let levels = 0, need = xpToNext(p.level || 0);
  while (p.xp >= need) { p.xp -= need; p.level = (p.level || 0) + 1; levels++; need = xpToNext(p.level); }
  return levels;
}

export { C as config };
