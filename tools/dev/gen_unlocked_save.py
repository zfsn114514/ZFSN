#!/usr/bin/env python3
"""
构造 PvZ-Portable 全解锁存档。

存档格式来自源码（wszqkzqk/PvZ-Portable）：
  src/Lawn/System/PlayerInfo.cpp  PlayerInfo::SyncDetails
  src/Lawn/System/ProfileMgr.cpp  ProfileMgr::SyncState / PlayerInfo::SyncSummary

user{id}.dat 布局（全部小端，紧凑排列，无文件头）：
  0x000 u32  version (= 12, gUserVersion)
  0x004 u32  mLevel
  0x008 u32  mCoins
  0x00C u32  mFinishedAdventure
  0x010 u32[100] mChallengeRecords
  0x1A0 u32[80]  mPurchases
  0x2E0 u32  mPlayTimeActivePlayer
  0x2E4 u32  mPlayTimeInactivePlayer
  0x2E8 u32  mHasUsedCheatKeys
  0x2EC u32  mHasWokenStinky
  0x2F0 u32  mDidntPurchasePacketUpgrade
  0x2F4 u32  mLastStinkyChocolateTime
  0x2F8 u32  mStinkyPosX
  0x2FC u32  mStinkyPosY
  0x300 u32  mHasUnlockedMinigames
  0x304 u32  mHasUnlockedPuzzleMode
  0x308 u32  mHasNewMiniGame
  0x30C u32  mHasNewScaryPotter
  0x310 u32  mHasNewIZombie
  0x314 u32  mHasNewSurvival
  0x318 u32  mHasUnlockedSurvivalMode
  0x31C u32  mNeedsMessageOnGameSelector
  0x320 u32  mNeedsMagicTacoReward
  0x324 u32  mHasSeenStinky
  0x328 u32  mHasSeenUpsell
  0x32C u32  mPlaceHolderPlayerStats
  0x330 u32  mNumPottedPlants
  0x334 PottedPlant[mNumPottedPlants]
  ...   u16[20] mEarnedAchievements
  ...   u8      mZombatarAccepted
  ...   u32     mZombatarHeadCount
  ...   u8[0x14] minigame flags（读时丢弃）
  ...   u8      mZombatarCreatedBefore

users.dat 布局：
  u32 version (= 14, gProfileVersion)
  u16 count
  count × { u16 nameLen; char[nameLen] name; u32 useSeq; u32 id }

读取端是宽容的：尾部多余字节被忽略；不足才抛 DataReaderException
（而那一段被 try/catch 包住，只会重置 Zombatar 数据，不影响主体字段）。
"""

import struct
import sys

PROFILE_VERSION = 14
USER_VERSION = 12

NUM_CHALLENGE_RECORDS = 100
NUM_PURCHASES = 80
NUM_ACHIEVEMENTS = 20

# 21 个单值 u32 字段，紧接在 mPurchases 之后
FLAGS = [
    "mPlayTimeActivePlayer",
    "mPlayTimeInactivePlayer",
    "mHasUsedCheatKeys",
    "mHasWokenStinky",
    "mDidntPurchasePacketUpgrade",
    "mLastStinkyChocolateTime",
    "mStinkyPosX",
    "mStinkyPosY",
    "mHasUnlockedMinigames",
    "mHasUnlockedPuzzleMode",
    "mHasNewMiniGame",
    "mHasNewScaryPotter",
    "mHasNewIZombie",
    "mHasNewSurvival",
    "mHasUnlockedSurvivalMode",
    "mNeedsMessageOnGameSelector",
    "mNeedsMagicTacoReward",
    "mHasSeenStinky",
    "mHasSeenUpsell",
    "mPlaceHolderPlayerStats",
]

TOTAL_LEVELS = 50      # 原版冒险模式关卡数
FINAL_LEVEL = 50       # mLevel 设为 50 → 第 1..50 关全部解锁
MAX_COINS = 99999      # AddCoins 里的 clamp 上限


def build_user(name_len_check=None):
    """构造全解锁的 user{id}.dat。"""
    buf = bytearray()

    buf += struct.pack("<I", USER_VERSION)          # version
    buf += struct.pack("<I", FINAL_LEVEL)           # mLevel：1..50 全解锁
    buf += struct.pack("<I", MAX_COINS)             # mCoins
    buf += struct.pack("<I", 1)                     # mFinishedAdventure

    # 挑战/生存模式纪录：给一个较大的值，菜单里显示为已通关。
    # 注意读侧把 [0x0F, 0x0F+20) 派生成 minigame flags，非零即解锁。
    for i in range(NUM_CHALLENGE_RECORDS):
        buf += struct.pack("<I", 100000)

    # 商店：全部买下（源码里按 StoreItem 索引，1 = 已购买）
    for i in range(NUM_PURCHASES):
        buf += struct.pack("<I", 1)

    values = {
        "mPlayTimeActivePlayer": 3600,
        "mPlayTimeInactivePlayer": 0,
        "mHasUsedCheatKeys": 1,          # 跳过教程/开场动画
        "mHasWokenStinky": 1,
        "mDidntPurchasePacketUpgrade": 1,
        "mLastStinkyChocolateTime": 0,
        "mStinkyPosX": 0,
        "mStinkyPosY": 0,
        "mHasUnlockedMinigames": 1,
        "mHasUnlockedPuzzleMode": 1,
        "mHasNewMiniGame": 1,
        "mHasNewScaryPotter": 1,
        "mHasNewIZombie": 1,
        "mHasNewSurvival": 1,
        "mHasUnlockedSurvivalMode": 1,
        "mNeedsMessageOnGameSelector": 0,
        "mNeedsMagicTacoReward": 0,
        "mHasSeenStinky": 1,
        "mHasSeenUpsell": 1,
        "mPlaceHolderPlayerStats": 0,
    }
    for key in FLAGS:
        buf += struct.pack("<I", values[key])

    buf += struct.pack("<I", 0)                      # mNumPottedPlants

    # ---- 到这里偏移应为 0x334 ----
    assert len(buf) == 0x334, hex(len(buf))

    for i in range(NUM_ACHIEVEMENTS):                # 全部成就
        buf += struct.pack("<H", 1)

    buf += struct.pack("<B", 0)                      # mZombatarAccepted
    buf += struct.pack("<I", 0)                      # mZombatarHeadCount
    buf += b"\x00" * 0x14                            # minigame flags（读时丢弃）
    buf += struct.pack("<B", 0)                      # mZombatarCreatedBefore

    return bytes(buf)


def build_users(name="Zsn", use_seq=1, profile_id=1):
    """构造只含一个 profile 的 users.dat。"""
    raw = name.encode("utf-8")
    buf = bytearray()
    buf += struct.pack("<I", PROFILE_VERSION)
    buf += struct.pack("<H", 1)
    buf += struct.pack("<H", len(raw))
    buf += raw
    buf += struct.pack("<I", use_seq)
    buf += struct.pack("<I", profile_id)
    return bytes(buf)


def describe(data):
    """把字节解回来，用于自检。"""
    out = []
    off = 0
    ver, = struct.unpack_from("<I", data, off); off += 4
    lvl, = struct.unpack_from("<I", data, off); off += 4
    coins, = struct.unpack_from("<I", data, off); off += 4
    fin, = struct.unpack_from("<I", data, off); off += 4
    out.append(f"version={ver} mLevel={lvl} mCoins={coins} mFinishedAdventure={fin}")
    recs = list(struct.unpack_from("<%dI" % NUM_CHALLENGE_RECORDS, data, off))
    off += 4 * NUM_CHALLENGE_RECORDS
    out.append(f"mChallengeRecords: {len(recs)} 项, 非零 {sum(1 for r in recs if r)}")
    purch = list(struct.unpack_from("<%dI" % NUM_PURCHASES, data, off))
    off += 4 * NUM_PURCHASES
    out.append(f"mPurchases: {len(purch)} 项, 已购 {sum(1 for p in purch if p)}")
    for key in FLAGS:
        v, = struct.unpack_from("<I", data, off); off += 4
        if v:
            out.append(f"  {key} = {v}")
    npp, = struct.unpack_from("<I", data, off); off += 4
    out.append(f"mNumPottedPlants={npp}")
    out.append(f"字段区结束偏移 = 0x{off:X}")
    return "\n".join(out)


if __name__ == "__main__":
    import os

    user = build_user()
    users = build_users()

    print("user1.dat = %d 字节" % len(user))
    print(describe(user))
    print()
    print("users.dat = %d 字节" % len(users))
    print(" ", users.hex())

    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "user1.dat"), "wb") as f:
        f.write(user)
    with open(os.path.join(outdir, "users.dat"), "wb") as f:
        f.write(users)
    print("\n已写入:", outdir)
