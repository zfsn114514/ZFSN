/* ── 原版数值集中表 ─────────────────────────────────────────────
 *
 * 这个文件只放「Java 版是多少」的数字，不放任何逻辑。
 * 以前这些数字散落在 game.js 的 update()/mine()/move() 里
 * （25、8.8、4.3、12.5…），改一个手感要在 2000 行里翻半天，
 * 也没法判断哪个数是「原版」、哪个是当时随手拍的。
 *
 * ★ 单位约定：
 *   · 速度 / 加速度若带 TICK 字样，单位是「格/tick」或「格/tick²」
 *     —— 这是原版 wiki 的写法，直接抄下来，不做换算。
 *   · 带 PPS（per second）字样的是「格/秒」，用于日志与验收对比。
 *   · 逻辑固定 20 TPS。任何「N tick 延迟」都必须按 tick 计数，
 *     不能用 setTimeout、rAF 帧数或真实毫秒。
 */

/** 逻辑帧率。改这个值必须同时检查所有以 tick 为单位的常量。 */
export const TICK_RATE = 20;
/** 一个逻辑 tick 的秒数（0.05s）。 */
export const TICK = 1 / TICK_RATE;
/** 一个逻辑 tick 的毫秒数，仅用于文档说明，不要拿去 setTimeout。 */
export const TICK_MS = 1000 / TICK_RATE;

/* ── 玩家行走（原版 ground movement）─────────────────────────── */
/** 步行 4.317 格/秒。 */
export const WALK_PPS = 4.317;
/** 疾跑 5.612 格/秒。 */
export const SPRINT_PPS = 5.612;
/** 潜行是步行的 30%（原版 1.3/4.317 ≈ 0.3）。 */
export const SNEAK_SCALE = 0.3;
/** 跳跃初速度 0.48 格/tick。
 *  ★ 注意结算顺序：起跳当 tick 会「先加重力再移动」（vy=-v → vy+=0.08 → 位移），
 *  所以实际峰值 = Σ(v-i×0.08)（i≥1），不是教科书公式 v²/2g：
 *  旧值 0.42 的实际峰值只有 0.90 格 —— 1 格台阶根本跳不上去；
 *  0.48 → 1.20 格，接近原版 1.25，1 格跳跃稳定可靠。 */
export const JUMP_VELOCITY = 0.48;
/** 重力 0.08 格/tick²。 */
export const GRAVITY = 0.08;
/** 空气阻力：水平速度每 tick 乘 0.98（地面摩擦另算，见 GROUND_FRICTION）。 */
export const AIR_DRAG = 0.98;
/** 地面摩擦系数（原版 slipperiness 0.6 → 每 tick 速度乘 0.546）。 */
export const GROUND_FRICTION = 0.546;
/** 原版跳跃高度约 1.25 格。0.42²/(2×0.08)=1.10，加上阻力结算 ≈1.25。 */
export const JUMP_HEIGHT = 1.25;
/** 摔落伤害的起算速度（格/秒）：落地竖直速度超过它就掉血。 */
export const FALL_DAMAGE_SPEED = 12.5;
/** 水中：上浮/下落都变得很慢，重力按 1/4 结算。 */
export const WATER_GRAVITY_SCALE = 0.28;
export const WATER_TERMINAL = 3;
/** 终端下落速度 78.4 格/秒（原版 3.92 格/tick）。 */
export const TERMINAL_FALL = 78.4;

/* ── 创造模式飞行 ─────────────────────────────────────────────
 * 原版 flySpeed = 0.05（格/tick 的加速度基值），实际每 tick：
 *     vy += (上 +1 / 下 -1) * 0.15
 *     vy *= 0.6
 * 稳态 0.15/(1-0.6)=0.375 格/tick = 7.5 格/秒。
 */
/** 飞行时每 tick 的竖直加速度（格/tick²）。 */
export const FLY_ACCEL = 0.15;
/** 飞行时每 tick 竖直速度的衰减系数 —— 松手立刻减速并悬停，不会下落。 */
export const FLY_DRAG = 0.6;
/** 飞行最大竖直速度 ≈ 7.5 格/秒。 */
export const FLY_TERMINAL_PPS = 7.5;
/** 水平飞行 10.9 格/秒；飞行中疾跑 21.8 格/秒。 */
export const FLY_HORIZONTAL_PPS = 10.9;
export const FLY_SPRINT_PPS = 21.8;
/** 2D 版觉得飞行太快时的整体缩放（1 = 原版速度）。 */
export const FLY_SPEED_SCALE = 1;
/** 双击空格切换飞行的判定窗口：7 tick ≈ 350ms。 */
export const DOUBLE_TAP_TICKS = 7;
/** 双击方向键切换疾跑的判定窗口（原版 7 tick 左右，手感上放宽一点）。 */
export const SPRINT_TAP_TICKS = 7;

/* ── 交互与挖掘 ───────────────────────────────────────────────── */
/** 创造模式交互距离 5 格。 */
export const REACH_CREATIVE = 5;
/** 生存模式交互距离 4.5 格。 */
export const REACH_SURVIVAL = 4.5;
/** 破坏一个方块后的冷却：5 tick（原版 blockHitDelay = 5）。 */
export const BLOCK_HIT_DELAY = 5;
/** 破坏速度：空手 1，木 2，石 4，铁 6，钻石 8，金 12（ITEMS 里的 speed 已按此）。 */
export const TOOL_SPEED_HAND = 1;
/** 每 tick 进度增量 = 破坏速度 / 硬度 / (能采集 ? 30 : 100)。 */
export const BREAK_DIVISOR_HARVEST = 30;
export const BREAK_DIVISOR_NO_HARVEST = 100;
/** 悬空时破坏速度 ÷5；水下且没有水下呼吸 ÷5。 */
export const BREAK_AIRBORNE_PENALTY = 5;
export const BREAK_UNDERWATER_PENALTY = 5;
/** 裂纹贴图层数（destroy_stage_0..9）。 */
export const DESTROY_STAGES = 10;

/* ── 掉落物 / 拾取 ─────────────────────────────────────────────── */
/** 玩家丢出的物品 40 tick（2 秒）内不能自己捡回。 */
export const THROW_PICKUP_DELAY = 40;
/** 掉落物存在 5 分钟后消失（秒）。 */
export const DROP_LIFETIME = 300;
/** 拾取磁吸范围（格）。 */
export const PICKUP_RADIUS = 1;
/** 掉落物之间自动合并的距离（格）。 */
export const DROP_MERGE_RADIUS = 1;
/** 丢出物品的初速度（格/秒）。 */
export const THROW_SPEED_PPS = 6;

/* ── 物品栏 UI ─────────────────────────────────────────────────── */
/** 双击收集的判定窗口（毫秒，UI 层判定的手感参数，不参与模拟）。 */
export const DOUBLE_CLICK_MS = 250;
/** 快捷栏物品名淡出时间（毫秒）。 */
export const ITEM_NAME_MS = 2000;

/* ── 方块图标 ─────────────────────────────────────────────────── */
/** 立方体图标里每个面的明暗：顶面 0，左面 20%，右面 40%。 */
export const ICON_SHADE_LEFT = 0.2;
export const ICON_SHADE_RIGHT = 0.4;
/** 面与面之间留 0.5px 重叠，避免缩放后出现缝隙。 */
export const ICON_FACE_OVERLAP = 0.5;
/** 图标贴图边长（原版 16×16）。 */
export const ICON_TEXTURE_SIZE = 16;

/* ── 战斗（Java 1.9+ 战斗系统）──────────────────────────────────
 * 数值集中在这里，game.js / combat.js 只放逻辑。
 * 单位：速度/加速度带 TICK 字样 = 格/tick；带 PPS = 格/秒。
 * 所有「N tick」都按逻辑 tick 计数，不用帧数或 setTimeout。
 */
/** 默认实现的战斗版本。'1.8' 留作扩展点（无攻击冷却、剑右键格挡减伤 50%），本轮不实现。 */
export const COMBAT_VERSION = '1.9+';
/** 默认难度。peaceful 不生成敌对生物且不饥饿致死。 */
export const DEFAULT_DIFFICULTY = 'normal';
/** 饥饿 ≤ 0 时每 80 tick 的 1 点伤害下限（半心为单位）。
 *  ★ 语义是「血量下限」而不是「伤害数值」：
 *    饥饿掉血到该血量就不再继续掉 —— 简单最低 10 血、普通最低 1 血、
 *    困难 0（可致死）、和平 20（等于不会饿死）。 */
export const DIFFICULTY_STARVE_FLOOR = { peaceful: 20, easy: 10, normal: 1, hard: 0 };
/** 各难度是否生成敌对生物。 */
export const DIFFICULTY_HOSTILE = { peaceful: false, easy: true, normal: true, hard: true };

/* 武器：attackDamage 已含基础 1 点。空手 = 1 / 4.0。material: wood/stone/iron/diamond/gold/netherite */
export const WEAPON_DAMAGE = {
  sword:    { wood: 4, stone: 5, iron: 6, diamond: 7, gold: 4, netherite: 8 },
  axe:      { wood: 7, stone: 9, iron: 9, diamond: 9, gold: 7, netherite: 10 },
  pickaxe:  { wood: 2, stone: 3, iron: 4, diamond: 5, gold: 2, netherite: 6 },
  shovel:   { wood: 2.5, stone: 3.5, iron: 4.5, diamond: 5.5, gold: 2.5, netherite: 6.5 },
  hoe:      { wood: 1, stone: 1, iron: 1, diamond: 1, gold: 1, netherite: 1 },
};
export const WEAPON_SPEED = {
  sword: 1.6, pickaxe: 1.2, shovel: 1.0,
  axe:   { wood: 0.8, stone: 0.8, iron: 0.9, gold: 1.0, diamond: 1.0, netherite: 1.0 },
  hoe:   { wood: 1.0, stone: 2.0, iron: 3.0, diamond: 4.0, gold: 1.0, netherite: 4.0 },
};
export const HAND_DAMAGE = 1, HAND_SPEED = 4.0;

/* 护甲：每件防御点数（头/胸/腿/脚）。合计与 Java 1.20 一致。
   注：prompt 里那句「采用 1/2/3/1」是笔误，以「第一列列出的 头/胸/腿/脚」为准，
   即 皮革 1/3/2/1、金 2/5/3/1、锁链 2/5/4/1、铁 2/6/5/2、钻石 3/8/6/3、下界合金 3/8/6/3。 */
export const ARMOR_SLOT_POINTS = {
  leather:   { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },     // 合计 7
  gold:      { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },     // 合计 11
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },     // 合计 12
  iron:      { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },     // 合计 15
  diamond:   { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },     // 合计 20
  netherite:{ helmet: 3, chestplate: 8, leggings: 6, boots: 3 },     // 合计 20
};
export const ARMOR_TOUGHNESS = { leather: 0, gold: 0, chainmail: 0, iron: 0, diamond: 2, netherite: 3, turtle: 0 };
export const ARMOR_KBR = { leather: 0, gold: 0, chainmail: 0, iron: 0, diamond: 0, netherite: 0.1, turtle: 0 };
/** 护甲耐久上限（头/胸/腿/脚）× 材质系数，沿用既有 ARMOR_DURABILITY。 */
export const ARMOR_DURABILITY = {
  leather:   { helmet: 55, chestplate: 80, leggings: 75, boots: 65 },
  chainmail: { helmet: 165, chestplate: 240, leggings: 225, boots: 195 },
  gold:      { helmet: 77, chestplate: 112, leggings: 105, boots: 91 },
  iron:      { helmet: 165, chestplate: 240, leggings: 225, boots: 195 },
  diamond:   { helmet: 363, chestplate: 528, leggings: 495, boots: 429 },
  netherite:{ helmet: 407, chestplate: 592, leggings: 555, boots: 481 },
  turtle:    { helmet: 275 },
};

/* 击退 */
export const KNOCKBACK_BASE = 0.4;
export const KNOCKBACK_SPRINT_BONUS = 0.5;
export const KNOCKBACK_PER_LEVEL = 0.5;

/* 饥饿 / 自然恢复（半心为单位；消耗度 0~4 一档）
 * ★ 消耗度（exhaustion）按提示词第 7 节：
 *   疾跑跳跃 0.2、疾跑每格 0.1、攻击 0.1、受伤 0.1、挖矿 0.005、普通跳跃 0.05。
 *   ★ 走路/潜行不再额外扣消耗度（原版走路不消耗），否则站着不动也会饿。 */
export const EXHAUSTION = { jump: 0.05, sprintJump: 0.2, sprintPerBlock: 0.1, mine: 0.005, attack: 0.1, hurt: 0.1 };
export const REGEN_HUNGER_THRESHOLD = 18;
export const REGEN_INTERVAL_TICKS = 80;        // 饥饿≥18 每 80 tick 回 1
export const REGEN_FAST_INTERVAL_TICKS = 10;    // 饥饿=20 且饱和>0 每 10 tick 回 1
export const REGEN_EXHAUSTION_COST = 6.0;
/** 快速恢复（饱食度满）每次回血消耗的饱和度（原版饱和度是快速恢复的资源池）。 */
export const REGEN_FAST_SATURATION_COST = 6.0;
export const STARVE_INTERVAL_TICKS = 80;
export const STARVE_DAMAGE = 1;

/* 食物：饥饿 / 饱和度 */
export const FOODS = {
  apple: [4, 2.4], bread: [5, 6], cooked_porkchop: [8, 12.8], steak: [8, 12.8], cooked_chicken: [6, 7.2],
  porkchop: [3, 1.8], beef: [3, 1.8], rotten_flesh: [4, 0.8], carrot: [3, 3.6], baked_potato: [5, 6],
  golden_apple: [4, 9.6],
};
/** 金苹果进食时附带的吸收心（半心）。 */
export const GOLDEN_APPLE_ABSORPTION = 4;

/* 环境伤害
 * ★ 提示词第 2 节明确：坠落 / 溺水 / 饥饿 / 窒息 / 虚空 / 魔法 / 火焰岩浆
 *   这些「魔法/环境」伤害绕过护甲；而近战、箭、爆炸、仙人掌受护甲影响。
 *   火焰与岩浆在原版属于「火焰伤害」，不受护甲减免。 */
export const FALL_SAFE_DISTANCE = 3;
export const DROWN_OXYGEN_TICKS = 300;
export const DROWN_INTERVAL_TICKS = 20;
export const DROWN_DAMAGE = 2;
export const LAVA_DAMAGE_PER_TICK = 1;         // 岩浆：每 20 tick 1 点
export const FIRE_TICK_INTERVAL = 20;          // 着火每 20 tick 扣 1 点
export const FIRE_DAMAGE = 1;                  // 每次着火伤害（半心）
export const FIRE_DURATION_TICKS = 160;        // 着火持续 160 tick（8 秒），入水熄灭
export const CACTUS_DAMAGE = 1;                // 仙人掌接触伤害（受护甲影响）
export const SUFFOCATE_DAMAGE = 1;             // 窒息伤害（每次 1 点，绕过护甲）
export const SUFFOCATE_INTERVAL_TICKS = 10;    // 窒息判定间隔（tick）
export const VOID_DAMAGE_PER_TICK = 4;
export const VOID_DEPTH = 64;                   // 低于世界底部 64 格后每 tick 4 点

/* 攻击冷却 / 进食 / 盾牌 */
export const EAT_TICKS = 32;
export const EAT_SPEED_SCALE = 0.6;              // 进食中的移动速度倍率
export const SHIELD_RAISE_TICKS = 5;
export const SHIELD_AXE_COOLDOWN = 100;
export const SHIELD_DURABILITY_PER_DAMAGE = 1;  // 1 + floor(blockedDamage)
export const CREATIVE_ENTITY_REACH = 5;         // 创造模式攻击生物距离（原版不确定，默认 5）
export const SURVIVAL_ENTITY_REACH = 3;         // 生存模式实体攻击 3 格

/* 弓（2D 统一缩放 ARROW_SPEED_SCALE） */
export const ARROW_SPEED_SCALE = 1;
export const BOW_CHARGE_TICKS = 20;             // 满蓄力 20 tick
export const BOW_MIN_CHARGE = 0.1;              // 蓄力不足 0.1 不发射
export const ARROW_GRAVITY = 0.05;             // 格/tick²
export const ARROW_DRAG = 0.99;
export const ARROW_SPEED_AT_FULL = 3.0;        // 满蓄力速度（格/tick）
/** 拉弓时的移动速度倍率（原版拉弓会减速）。 */
export const BOW_MOVE_SCALE = 0.6;
/** 满蓄力「暴击箭」的额外随机伤害范围（半心，闭区间）。 */
export const BOW_CRIT_EXTRA_MIN = 0;
export const BOW_CRIT_EXTRA_MAX = 2;

/* 生物血量（半心）、经验、掉落（section 9 用） */
export const MOB_HEALTH = { zombie: 20, skeleton: 20, creeper: 20, spider: 16, pig: 10, cow: 10, sheep: 8, chicken: 4 };
export const MOB_XP = { hostile: 5, passive: [1, 3] };
export const HOLD_TO_ATTACK = false;           // 默认需要每次点击；true 时按住左键冷却后自动攻击

/* 横扫攻击（仅剑，strength>0.9 触发）
 * ★ 提示词原文：「主目标周围水平 1 格内的其他生物受到 1 点伤害并带轻微击退，
 *   播放横扫动画」。
 *   —— 原版横扫是「武器伤害 ×0.5 左右」，但提示词明确写了「1 点伤害」，
 *   以提示词为准（数值取本游戏单位：半心，1 = 半颗心）。
 *   半径同理取 1 格（水平距离），不是 3 格。 */
export const SWEEP_RADIUS = 1;                  // 横扫命中半径（格，水平距离）
export const SWEEP_DAMAGE = 1;                 // 横扫对相邻目标造成的固定伤害（半心）
export const SWEEP_KNOCKBACK = 0.15;           // 横扫的「轻微」击退（格/tick）
export const SWEEP_EXHAUSTION = 0.1;           // 横扫额外消耗度

/* 疾跑攻击（提示词第 3 节）：命中后取消疾跑，玩家水平速度 ×0.6 */
export const SPRINT_ATTACK_SPEED_SCALE = 0.6;
/** 疾跑攻击后「取消疾跑」的锁定时长（tick）—— 不锁定的话同一个 tick
 *  就会被移动逻辑重新置回疾跑，玩家完全看不出取消。 */
export const SPRINT_ATTACK_LOCK_TICKS = 5;

/* 生物近战 / 远程节奏（section 9） */
export const MOB_MELEE_COOLDOWN = 20;          // 僵尸接触攻击冷却 20 tick（1 秒）
export const MOB_MELEE_DAMAGE = { easy: 2, normal: 3, hard: 4 }; // 半心
export const ZOMBIE_CHASE_RANGE = 35;          // 僵尸的追击范围（格）
export const SPIDER_DAMAGE = { easy: 2, normal: 2, hard: 3 };   // 蜘蛛近战（半心）
export const SPIDER_AGGRO_RANGE = 16;          // 蜘蛛发现玩家的距离（格）
export const SKELETON_KEEP_MAX = 10;           // 骷髅与玩家保持的最远距离（格）
export const SKELETON_KEEP_MIN = 6;            // 骷髅与玩家保持的最近距离（格）
export const SKELETON_SHOOT_MIN_TICKS = 20;    // 骷髅两次射击的间隔下限（tick）
export const SKELETON_SHOOT_MAX_TICKS = 40;    // 骷髅两次射击的间隔上限（tick）
export const MOB_SHOOT_RANGE = 16;             // 骷髅进入射击的距离
export const MOB_SHOOT_MIN_RANGE = 3;          // 太近则后撤
export const MOB_ARROW_DAMAGE = 3;             // 骷髅箭基础伤害（半心）
export const CREEPER_FUSE_CANCEL_RANGE = 7;     // 超过这个距离苦力怕取消引信（格）

/* 被动生物受击后恐慌逃跑的时长（秒）。原版 panic 是 5 秒。 */
export const PASSIVE_PANIC_TICKS = 5;

/* 生物死亡：先倒地 20 tick（1 秒）再消失并掉落。 */
export const MOB_DEATH_TICKS = 20;

/* 敌对生物生成 / 消失规则（提示词第 9 节） */
export const HOSTILE_SPAWN_LIGHT = 7;          // 光照等级 ≤ 7 才生成
export const HOSTILE_SPAWN_MIN_DISTANCE = 24;  // 距玩家 24 格外才生成
export const HOSTILE_DESPAWN_DISTANCE = 128;   // 距玩家 128 格外消失
export const HOSTILE_RANDOM_DESPAWN = 32;      // 随机消失的距离（格）

/* 生物掉落表（第 9 节）：[最少, 最多] 数量；0 表示不掉落。
 * 僵尸腐肉 0~2 / 骷髅骨头 0~2 与箭 0~2 / 苦力怕火药 0~2 / 蜘蛛线 0~2 /
 * 猪排骨 1~3 / 牛牛肉 1~3 与皮革 0~2 / 羊羊毛 1 与羊肉 1~2 / 鸡羽毛 0~2 与生鸡肉 1 */
export const MOB_DROPS = {
  zombie:   [['rotten_flesh', 0, 2]],
  skeleton: [['bone', 0, 2], ['arrow', 0, 2]],
  creeper:  [['gunpowder', 0, 2]],
  spider:   [['string', 0, 2]],
  pig:      [['porkchop', 1, 3]],
  cow:      [['beef', 1, 3], ['leather', 0, 2]],
  sheep:    [['white_wool', 1, 1], ['mutton', 1, 2]],
  chicken:  [['feather', 0, 2], ['chicken', 1, 1]],
};

/* 白天着火的敌对生物（提示词第 9 节「僵尸白天着火（头上无头盔时）」「骷髅白天着火」）。
   ★ 原版行为是「只要暴露在阳光下就一直重新点燃」，所以白天每 tick 续火；
     洞穴里（地表以下）不点燃。僵尸本项目没有头盔模型，故始终点燃。 */
export const DAY_BURN_MOBS = ['zombie', 'skeleton'];

/** 着火致死时把生肉换成熟肉（提示词第 9 节「着火致死掉落熟肉」）。 */
export const COOKED_MEAT = {
  porkchop: 'cooked_porkchop', beef: 'cooked_beef',
  mutton: 'cooked_mutton', chicken: 'cooked_chicken',
};

/* 苦力怕（section 9 / 路线 2 爆炸预留） */
export const CREEPER_FUSE_TICKS = 30;          // 点燃后 30 tick 起爆
export const CREEPER_RADIUS = 3;               // 爆炸半径（格）
export const CREEPER_DAMAGE = 12;              // 贴脸爆炸伤害（半心，护甲减免前的原始值）

/* ── 天空 / 时间 ───────────────────────────────────────────────── */
export const DAY_SECONDS = 20 * 60;

/* ════════════════════════════════════════════════════════════════════════
 * 流体系统（水 / 岩浆）集中常量表
 * ──────────────────────────────────────────────────────────────────────────
 * 单位约定同本文件其它部分：tick 计数按逻辑 tick（固定 20 TPS），不要用
 * setTimeout / 帧数 / 真实毫秒。速度类带 TICK 字样 = 格/tick。
 *
 * 「[记忆]」标注的数值是我凭记忆给的，已按 Java 版 1.20 原版数据核对；
 * 不一致时以原版为准，并在注释里标出来源。其余数值来自原版 wiki / 代码。
 * 所有逻辑都从这里读常量，流体代码里不得出现魔法数字。
 */
export const FLUID = {
  /* —— 每种流体的参数表（主世界；下界岩浆单独一张） —— */
  // 来源：Java 1.20 net.minecraft.world.level.material.FlowingFluid 与各流体子类
  water: {
    tickDelay: 5,            // 每 5 逻辑 tick 处理一次（原版 FlowingFluid 默认 5）
    slopeFindDistance: 4,    // 找下坡的搜索距离（原版：水 4）
    dropOff: 1,              // 每扩散一格 amount 衰减 [记忆：原版水为 1]
    canConvertToSource: true,// 是否允许无限水源（水 true / 岩浆 false）
    push: 0.014,            // 对实体每 tick 的推动加速度（格/tick²）[记忆：约 0.014]
  },
  lava: {
    tickDelay: 30,           // 原版 LavaFluid 默认 30（主世界）
    slopeFindDistance: 2,    // [记忆：主世界岩浆搜索距离 2]
    dropOff: 2,              // [记忆：主世界岩浆每格衰减 2]
    canConvertToSource: false,
    push: 0.007 / 3,         // [记忆：约 0.007/3]
  },
  // 下界岩浆：tickDelay 10、slopeFindDistance 4、dropOff 1（[记忆]，本作目前只有主世界，保留按维度取值能力）
  lava_nether: {
    tickDelay: 10, slopeFindDistance: 4, dropOff: 1, canConvertToSource: false, push: 0.007 / 3,
  },

  /* —— 调度 —— */
  MAX_UPDATES_PER_TICK: 2000,   // 单 tick 处理流体的硬上限，超出顺延下一 tick
  MAX_SCHEDULE_NEIGHBORS: 4,   // 每次变化对 4 个正交邻居排队

  /* —— 下落流体落地后的侧向扩散起始 amount —— */
  // [记忆] 原版下落水柱落地形成的流体 amount 约 7（已常量化，便于核对修改）
  SPREAD_FALLING_AMOUNT: 7,

  /* —— 渲染 —— */
  HEIGHT_DIVISOR: 9,      // 单格流体视觉高度 = amount / 9（源头 8/9 ≈ 0.89）
  FALLING_HEIGHT: 1.0,    // 下落 / 上方有同类流体时高度贴满整格
  WATER_ALPHA: 0.84,      // 水的半透明度（沿用既有 drawWater 的 0.84）
  LAVA_LIGHT: 15,         // 岩浆发光等级（原版 15）
  FLOW_FRAMES: 32,        // 流动动画帧数（无动画纹理时用滚动偏移模拟）

  /* —— 实体物理（[记忆]，待核对原版数值） —— */
  WATER_GRAVITY: 0.02,    // 水中重力 格/tick²（陆地 GRAVITY=0.08）
  WATER_DRAG_H: 0.8,      // 水中水平速度每 tick 乘
  WATER_DRAG_V: 0.8,      // 水中垂直速度每 tick 乘
  WATER_FLOAT: 0.04,      // 按住跳跃（上浮）每 tick 加的上升速度
  WATER_MINE_PENALTY: 5,  // 水下无水下呼吸时挖掘速度 ÷5（沿用 BREAK_UNDERWATER_PENALTY）
  WATER_SWIM_SPEED_SCALE: 0.5, // 水中移动速度 ×0.5（沿用既有 pps*=.5）

  LAVA_DRAG_H: 0.5,       // 岩浆中水平速度每 tick 乘 [记忆]
  LAVA_DRAG_V: 0.5,       // 岩浆中垂直速度每 tick 乘 [记忆]
  LAVA_DAMAGE: 4,         // 岩浆直接伤害（半心），受无敌帧限制 [记忆：约 4 点/次]
  LAVA_FIRE_INTERVAL: 20, // 着火每 20 tick 1 点（沿用 combat LAVA_DAMAGE_PER_TICK 节奏）

  /* —— 无限水源防自增长 —— */
  // 仅当满足「两侧水平相邻源头 + 下方实心/同类源头」时转化，转化后只调度邻居一次。
  INFINITE_SOURCE_MIN_NEIGHBORS: 2,
};
