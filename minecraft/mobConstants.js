/* 生物系统共享常量。纯逻辑层，不依赖 DOM。
 * 时间单位一律为逻辑 tick（20 TPS）；速度若带 PPS 则为格/秒。 */
export const TICK_RATE = 20;

export const GOAL_FLAG = Object.freeze({ MOVE: 1, LOOK: 2, JUMP: 4, TARGET: 8, ATTACK: 16 });
export const MOB_CATEGORY = Object.freeze(['passive','neutral','hostile','boss','ambient','aquatic','utility']);
export const MOVEMENT_TYPES = Object.freeze(['walk','swim','fly','amphibious','hop','climb','stationary','teleport']);

/* AI / 实体更新 */
export const AI_FULL_RANGE = 64;
export const AI_LOW_RANGE = 96;
export const ENTITY_FREEZE_RANGE = 128;
export const AI_LOW_INTERVAL = 5;
export const AI_FAR_INTERVAL = 10;
export const PATH_REPATH_TICKS = 10;
export const PATH_FAR_REPATH_TICKS = 40;
export const PATH_BUDGET_MS = 2;
export const PATH_MAX_NODES = 1200;
export const PATH_CACHE_LIMIT = 128;
export const PATH_DANGER_COST = 24;
export const PATH_SWIM_COST = 1.2;
export const PATH_JUMP_COST = 1.5;
export const PATH_MAX_DROP = 3;
export const MOB_MAX_COUNT = 512;
export const VIEW_MOB_BUDGET = 240;

/* 生成。waterAmbient=20 是 Java 原版的独立鱼类上限；任务里漏写了这一类。 */
export const SPAWN_CAPS = Object.freeze({ hostile:70, passive:10, aquatic:5, undergroundAquatic:5, ambient:15, waterAmbient:20, utility:-1, boss:-1, neutral:10 });
export const HOSTILE_MIN_SPAWN_DISTANCE = 24;
export const HOSTILE_DESPAWN_DISTANCE = 128;
export const HOSTILE_RANDOM_DESPAWN_DISTANCE = 32;
export const HOSTILE_RANDOM_DESPAWN_CHANCE = 1 / 800; // 每 tick；2D 版避免 K.shouldDespawnHostile 的 50%/次骤清
export const HOSTILE_SPAWN_INTERVAL = 20;
export const PASSIVE_SPAWN_INTERVAL = 400;
export const SPAWN_GROUP_MAX = 4;
export const SPAWN_ATTEMPTS_PER_CYCLE = 3;
export const SPAWN_LIGHT_MAX = 7;
export const STRUCTURE_SPAWN_ENABLED = false;

/* 繁殖 / 成长 / 驯服 / 骑乘组件 */
export const BABY_SCALE = 0.5;
export const BABY_GROW_TICKS = 24000;       // 20 分钟
export const BABY_FEED_ACCEL = 0.1;         // 每次喂食减少剩余成长时间的 10%
export const LOVE_TICKS = 600;
export const BREED_COOLDOWN_TICKS = 6000;   // 5 分钟
export const BREED_RANGE = 2.2;
export const BREED_XP_MIN = 1;
export const BREED_XP_MAX = 7;
export const TEMPT_RANGE = 10;
export const FOLLOW_OWNER_RANGE = 12;
export const FOLLOW_OWNER_STOP = 2.5;
export const LEASH_MAX_DISTANCE = 10;
export const WOLF_TAME_CHANCE = 1 / 3;
export const CAT_TAME_CHANCE = 1 / 3;
export const PARROT_TAME_CHANCE = 1 / 3;
export const HORSE_TEMPER_MAX = 100;
export const HORSE_TEMPER_PER_RIDE = 5;
export const RIDE_JUMP_SPEED = 8.5;         // 格/秒，交给现有 move 重力系统
export const CAMEL_DASH_SPEED = 8;
export const MOUNT_WATER_SPEED_SCALE = 0.45;

/* 通用状态 */
export const MOB_DEATH_TICKS = 20;
export const MOB_ATTACK_COOLDOWN = 20;
export const MOB_HURT_PANIC_TICKS = 100;    // 5 秒
export const TARGET_MEMORY_TICKS = 200;
export const CALL_HELP_RANGE = 16;
export const CALL_HELP_CHANCE = 0.25;
export const FIRE_TICK_INTERVAL = 20;
export const FISH_AIR_DAMAGE_INTERVAL = 20;
export const DOLPHIN_AIR_DAMAGE_INTERVAL = 20;
export const AXOLOTL_PLAY_DEAD_TICKS = 200;
export const BEE_DEATH_AFTER_STING_TICKS = 600;
export const ARMADILLO_ROLL_TICKS = 100;
export const CHICKEN_EGG_MIN_TICKS = 6000;
export const CHICKEN_EGG_MAX_TICKS = 12000;
export const SHEEP_GRASS_INTERVAL = 1200;
export const ENDERMAN_TELEPORT_INTERVAL = 40;
export const ENDERMAN_TELEPORT_RANGE = 16;
export const PHANTOM_SLEEPLESS_TICKS = 72000; // 3 个游戏日
export const BOSS_BAR_RANGE = 64;
export const ENDER_DRAGON_ARENA_RX = 18;
export const ENDER_DRAGON_ARENA_RY = 8;
export const ENDER_DRAGON_PERIOD_TICKS = 400;
export const WITHER_REGEN_INTERVAL = 20;
export const WITHER_ARMOR_THRESHOLD = 0.5;

/* 战斗与掉落 */
export const DIFFICULTIES = Object.freeze(['peaceful','easy','normal','hard']);
export const DEFAULT_DAMAGE = Object.freeze({ peaceful:0, easy:1, normal:1, hard:1 });
export const COOKED_DROPS = Object.freeze({
  porkchop:'cooked_porkchop', beef:'cooked_beef', chicken:'cooked_chicken',
  mutton:'cooked_mutton', rabbit:'cooked_rabbit', cod:'cooked_cod', salmon:'cooked_salmon',
});
export const PASSIVE_XP = Object.freeze([1,3]);
export const HOSTILE_XP = 5;

/* 2D 物理 / 动画 */
export const MOB_JUMP_SPEED = 8;            // 现有生物移动系统的格/秒约定
export const MOB_SWIM_UP_SPEED = 2.3;
export const MOB_FLY_ACCEL = 10;
export const MOB_FLY_DRAG = 0.82;
export const MOB_FLY_MAX_SPEED = 5;
export const MOB_HOP_SPEED = 4.5;
export const MOB_CLIMB_SPEED = 2.4;
export const BABY_FOLLOW_RANGE = 8;
export const NAME_TAG_RANGE = 16;
export const DEBUG_PATH_MAX_POINTS = 80;

export const DEGRADE = Object.freeze({
  ENDERMAN_STARE: '没有 Z 轴视线锥：以玩家水平朝向 + 距离 + 无遮挡判定“被注视”。',
  CREEPER_APPROACH: '以 2D 欧氏距离和无遮挡逼近；逃离判定只看水平距离。',
  SHULKER_ATTACH: '没有六个面：仅允许附着地板或左右墙，潜影弹沿 2D 向量追踪。',
  ENDER_DRAGON_FLIGHT: '没有末地岛：在固定竞技场中心沿椭圆轨道飞行，水晶以竞技场节点代替。',
  PATH_3D: 'A* 只搜索 X/Y 剖面；左右为水平，向上为跳跃/游泳，不能绕过剖面外障碍。',
  VILLAGE_SCHEDULE: '没有村庄床位与工作站寻址：作息以时间为驱动，交易使用简化库存。',
  WARDEN_VIBRATION: '没有声波传播区块事件总线：移动、攻击、挖掘写入 2D 振动事件，监守者按半径检测。',
  RAID: '只保留事件接口；没有村庄、钟声与多波次进攻场景。',
});
