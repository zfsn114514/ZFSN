# -*- coding: utf-8 -*-
"""影子测试：把 install.bat 里会改系统状态的行动作换成 echo，只验证 cmd 解析。"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "install.bat")
s = open(SRC, "rb").read().decode("gbk")

BLOCK_PREFIX = (
    "pause", "exit /b", "reg add", "copy ", "powershell", "mkdir",
)
out = []
for l in s.split("\r\n"):
    st = l.strip()
    low = st.lower()
    if low.startswith(BLOCK_PREFIX) or low.startswith(">") or low.startswith(">>") \
            or low.startswith("if not exist") or "mkdir" in low:
        out.append("echo [SKIP] " + st[:60])
    else:
        out.append(l)
out += ["", "echo INSTALL_PARSE_OK"]
shadow = os.path.join(HERE, "_it.bat")
open(shadow, "wb").write("\r\n".join(out).encode("gbk"))

txt = os.path.join(HERE, "_it.txt")
with open(txt, "wb") as f:
    rc = subprocess.call(["cmd", "/c", shadow], stdout=f, stderr=subprocess.STDOUT)
d = open(txt, "rb").read().decode("gbk", errors="replace")

bad = [l for l in d.split("\r\n")
       if re.search(r"is not recognized|不是内部或外部命令|无效|syntax", l, re.I)]
print("cmd 退出码:", rc)
print("报错数:", len(bad), "->", "PASS" if not bad else "FAIL")
for l in bad[:10]:
    print("   ", l)
print("--- 关键行抽样 ---")
for l in d.split("\r\n"):
    if any(k in l for k in ("install cursor scheme", "INSTALL_PARSE_OK",
                            "Applying", "Writing theme", "Copying cursor")):
        print("   ", l)

os.remove(shadow)
os.remove(txt)
sys.exit(1 if bad else 0)
