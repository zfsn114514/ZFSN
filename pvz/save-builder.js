/**
 * 全解锁存档构造器（JS 版，移植自 tools/dev/gen_unlocked_save.py）
 * ─────────────────────────────────────────────────────────────
 * 存档格式来自 PvZ-Portable 源码（LGPL 开源，github.com/wszqkzqk/PvZ-Portable）：
 *   src/Lawn/System/PlayerInfo.cpp → PlayerInfo::SyncDetails
 *   src/Lawn/System/ProfileMgr.cpp → ProfileMgr::SyncState / PlayerInfo::SyncSummary
 *
 * user{id}.dat 是紧凑小端结构，没有文件头：
 *   0x000 u32      version (= 12)
 *   0x004 u32      mLevel            ← 1..50 全解锁就靠它
 *   0x008 u32      mCoins
 *   0x00C u32      mFinishedAdventure
 *   0x010 u32[100] mChallengeRecords
 *   0x1A0 u32[80]  mPurchases
 *   0x2E0 u32 ×21  各个 Has.../Needs... 开关
 *   0x330 u32      mNumPottedPlants
 *   0x334 PottedPlant[mNumPottedPlants]
 *   ...   u16[20]  mEarnedAchievements
 *   ...   u8/u32/u8[0x14]/u8  Zombatar 相关
 *
 * users.dat：
 *   u32 version (= 14) · u16 count · count×{ u16 nameLen · name · u32 useSeq · u32 id }
 */

var SAVE_PROFILE_VERSION = 14;   // gProfileVersion
var SAVE_USER_VERSION = 12;       // gUserVersion
var SAVE_NUM_CHALLENGE = 100;
var SAVE_NUM_PURCHASES = 80;
var SAVE_NUM_ACHIEVEMENTS = 20;
var SAVE_FINAL_LEVEL = 50;        // 冒险模式共 50 关
var SAVE_MAX_COINS = 99999;       // 源码里 AddCoins 的 clamp 上限

/* 0x2E0 起的 21 个单值字段，顺序严格对应源码 SyncDetails */
var SAVE_FLAG_NAMES = [
  "mPlayTimeActivePlayer", "mPlayTimeInactivePlayer", "mHasUsedCheatKeys",
  "mHasWokenStinky", "mDidntPurchasePacketUpgrade", "mLastStinkyChocolateTime",
  "mStinkyPosX", "mStinkyPosY", "mHasUnlockedMinigames", "mHasUnlockedPuzzleMode",
  "mHasNewMiniGame", "mHasNewScaryPotter", "mHasNewIZombie", "mHasNewSurvival",
  "mHasUnlockedSurvivalMode", "mNeedsMessageOnGameSelector", "mNeedsMagicTacoReward",
  "mHasSeenStinky", "mHasSeenUpsell", "mPlaceHolderPlayerStats",
];

function buildUnlockedUserDat() {
  var bytes = [];
  function u8(v) { bytes.push(v & 255); }
  function u16(v) { u8(v); u8(v >>> 8); }
  function u32(v) { u8(v); u8(v >>> 8); u8(v >>> 16); u8(v >>> 24); }
  function zeros(n) { for (var i = 0; i < n; i++) u8(0); }

  u32(SAVE_USER_VERSION);
  u32(SAVE_FINAL_LEVEL);          // mLevel：关卡 1..50 全部解锁
  u32(SAVE_MAX_COINS);
  u32(1);                         // mFinishedAdventure

  // 挑战 / 生存纪录。读侧把 [0x0F, 0x0F+20) 派生成 minigame flags，非零即解锁
  for (var i = 0; i < SAVE_NUM_CHALLENGE; i++) u32(100000);

  // 商店：全部买下（StoreItem 索引，1 = 已购买）
  for (var j = 0; j < SAVE_NUM_PURCHASES; j++) u32(1);

  var flags = {
    mPlayTimeActivePlayer: 3600,
    mPlayTimeInactivePlayer: 0,
    mHasUsedCheatKeys: 1,        // 跳过开场动画 / 教程提示
    mHasWokenStinky: 1,
    mDidntPurchasePacketUpgrade: 1,
    mLastStinkyChocolateTime: 0,
    mStinkyPosX: 0,
    mStinkyPosY: 0,
    mHasUnlockedMinigames: 1,
    mHasUnlockedPuzzleMode: 1,
    mHasNewMiniGame: 1,
    mHasNewScaryPotter: 1,
    mHasNewIZombie: 1,
    mHasNewSurvival: 1,
    mHasUnlockedSurvivalMode: 1,
    mNeedsMessageOnGameSelector: 0,
    mNeedsMagicTacoReward: 0,
    mHasSeenStinky: 1,
    mHasSeenUpsell: 1,
    mPlaceHolderPlayerStats: 0,
  };
  for (var k = 0; k < SAVE_FLAG_NAMES.length; k++) u32(flags[SAVE_FLAG_NAMES[k]]);

  u32(0);                         // mNumPottedPlants

  // 到这里必须是 0x334
  if (bytes.length !== 0x334) throw new Error("字段区偏移异常: 0x" + bytes.length.toString(16));

  for (var a = 0; a < SAVE_NUM_ACHIEVEMENTS; a++) u16(1);   // 全成就
  u8(0);                          // mZombatarAccepted
  u32(0);                         // mZombatarHeadCount
  zeros(0x14);                    // minigame flags（读时丢弃）
  u8(0);                          // mZombatarCreatedBefore

  return new Uint8Array(bytes);
}

function buildUsersDat(name, useSeq, profileId) {
  var bytes = [];
  function u8(v) { bytes.push(v & 255); }
  function u16(v) { u8(v); u8(v >>> 8); }
  function u32(v) { u8(v); u8(v >>> 8); u8(v >>> 16); u8(v >>> 24); }

  // 名字按 UTF-8 编码，长度前缀也是字节数
  var raw = [];
  for (var i = 0; i < name.length; i++) {
    var cp = name.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) raw.push(cp);
    else if (cp < 0x800) raw.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else raw.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }

  u32(SAVE_PROFILE_VERSION);
  u16(1);                         // profile 数量
  u16(raw.length);
  for (var k = 0; k < raw.length; k++) u8(raw[k]);
  u32(useSeq >>> 0);
  u32(profileId >>> 0);

  return new Uint8Array(bytes);
}

/* 读回 user{id}.dat 的关键字段，用于写完后自检 */
function inspectUserDat(u8) {
  function rd32(off) {
    return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
  }
  var purchased = 0, i;
  for (i = 0; i < SAVE_NUM_PURCHASES; i++) if (rd32(0x1a0 + i * 4)) purchased++;
  return {
    size: u8.length,
    version: rd32(0),
    level: rd32(4),
    coins: rd32(8),
    finishedAdventure: rd32(12),
    challengeNonZero: (function () {
      var n = 0;
      for (var j = 0; j < SAVE_NUM_CHALLENGE; j++) if (rd32(0x10 + j * 4)) n++;
      return n;
    })(),
    purchases: purchased,
    numPottedPlants: rd32(0x330),
  };
}
