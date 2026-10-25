# -*- coding: utf-8 -*-
"""把 hash_assets.py 回写成 LF 的文件改回 CRLF（仓库约定）。"""
import sys

for f in sys.argv[1:]:
    b = open(f, 'rb').read()
    if b'\r\n' in b:
        print('本来就是 CRLF:', f)
        continue
    open(f, 'wb').write(b.replace(b'\n', b'\r\n'))
    print('转回 CRLF:', f)
