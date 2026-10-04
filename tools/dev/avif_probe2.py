# -*- coding: utf-8 -*-
"""
AVIF 落地可行性 —— 方案验证（只读，产出在 .tmp-avif/）

验证两个可能否决 AVIF 方案的技术风险：
  A. <picture> 与现有 blurUp() 是否冲突？
     blurUp 用 `new Image()` 预载真图再换 src。
     若改成 <picture>，「换 src」这步就失效了（picture 的 <source> 优先于 img.src）。
     本脚本生成一个真实页面来验证两种方案的可行性。

  B. AVIF 在这些图片上的解码正确性 / 视觉质量？
     生成 AVIF 副本 + 用 Pillow 解码回来算 PSNR，确认没有色偏、糊化。

用法：
    python tools/dev/avif_probe2.py
"""
import io
import os
import sys
import math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, ".tmp-avif")
sys.path.insert(0, os.path.join(ROOT, "tools"))

from PIL import Image  # noqa: E402

AVIF_Q = 62
AVIF_SPEED = 4

# 挑几张有代表性的：细腻摄影、渐变截图、大面积纯色、带透明
SAMPLES = [
    "assets/works/w20261002-191034-c997b941.jpg",   # 209 KB 最大的摄影图
    "assets/xbox/forza-horizon-5.jpg",              # 渐变 + 天空
    "assets/bili/BV1ZmFhe3EuZ.jpg",                 # 普通封面
    "assets/works/vrc.png",                         # PNG 截图（可能是 flat graphic）
    "assets/works/w20261002-033050-cea02996.png",   # PNG 截图
]


def psnr(a, b):
    """全量 PSNR（比 optimize_images.py 的抽样版严格，用于验收）"""
    if a.size != b.size:
        return None
    da = a.convert("RGB").tobytes()
    db = b.convert("RGB").tobytes()
    n = len(da)
    if n == 0:
        return None
    se = 0
    for i in range(n):
        d = da[i] - db[i]
        se += d * d
    mse = se / float(n)
    if mse <= 0:
        return 99.0
    return 10.0 * math.log10((255.0 ** 2) / mse)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("=" * 100)
    print("AVIF 方案验证   ——   输出目录：%s" % os.path.relpath(OUT, ROOT))
    print("=" * 100)
    print()
    print("── B. 解码正确性与视觉质量（全量 PSNR）──")
    print()
    print("%-44s %9s %9s %8s %8s" % ("文件", "webp主", "avif", "省", "PSNR"))
    print("-" * 100)

    tot_a = tot_b = 0
    bad = []
    for rel in SAMPLES:
        p = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print("%-44s  缺失，跳过" % rel[:44])
            continue
        before = os.path.getsize(p)
        im = Image.open(p)
        im.load()
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        work = im.convert("RGBA" if has_alpha else "RGB")

        b = io.BytesIO()
        work.save(b, format="AVIF", quality=AVIF_Q, speed=AVIF_SPEED)
        ab = b.getvalue()

        # 解码回来验收
        back = Image.open(io.BytesIO(ab))
        back.load()
        q = psnr(work, back)

        name = os.path.basename(rel)
        save = (1 - len(ab) / float(before)) * 100
        print("%-44s %9s %9s %7.1f%% %8s" % (
            name[:44], "%.0fK" % (before / 1024), "%.0fK" % (len(ab) / 1024),
            save, ("%.1f" % q) if q else "尺寸不符"))
        tot_a += before
        tot_b += len(ab)

        # 落盘样本，供浏览器实测
        dst = os.path.join(OUT, name + ".avif")
        with open(dst, "wb") as f:
            f.write(ab)
        # 顺手把原图也拷一份到 .tmp-avif 做对照页
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(open(p, "rb").read())

        if q is not None and q < 32:
            bad.append((rel, q))

    print("-" * 100)
    if tot_a:
        print("合计：%.0f KB → %.0f KB，省 %.1f%%" % (
            tot_a / 1024, tot_b / 1024, (1 - tot_b / float(tot_a)) * 100))
    print()
    if bad:
        print("⚠ 以下图 PSNR < 32（视觉无损下限），需单独处理：")
        for rel, q in bad:
            print("   %.1f dB  %s" % (q, rel))
    else:
        print("✅ 全部样本 PSNR ≥ 32 dB（视觉无损区间）")

    # ── 生成 A 项测试页 ──
    page = build_test_page(SAMPLES)
    pp = os.path.join(OUT, "picture-test.html")
    with open(pp, "w", encoding="utf-8") as f:
        f.write(page)
    print()
    print("已生成 <picture> 兼容性测试页：%s" % os.path.relpath(pp, ROOT))
    return 0


def build_test_page(samples):
    """生成一个测试页，验证 <picture> 与 blurUp 的两种写法"""
    cards = []
    for i, rel in enumerate(samples):
        name = os.path.basename(rel)
        cards.append("""
  <figure class="card">
    <h3>""" + str(i + 1) + """. """ + name + """</h3>
    <div class="row">
      <div class="cell">
        <p class="tag">方案① src 直接写 .avif（无降级）</p>
        <div class="box"><img data-i=\"""" + str(i) + """\" class="pimg" alt=""></div>
      </div>
      <div class="cell">
        <p class="tag">方案② &lt;picture&gt; + source（原生降级）</p>
        <div class="box">
          <picture>
            <source type="image/avif" srcset=\"""" + name + """.avif">
            <img class="pimg2" src=\"""" + name + """\" alt="">
          </picture>
        </div>
      </div>
      <div class="cell">
        <p class="tag">方案③ picture + blurUp 换 img.src</p>
        <div class="box">
          <picture>
            <source type="image/avif" srcset=\"""" + name + """.avif">
            <img data-i=\"""" + str(i) + """\" class="pimg3" alt="">
          </picture>
        </div>
      </div>
    </div>
  </figure>""")
    srcs_js = "[" + ",".join('"' + os.path.basename(s) + '"' for s in samples) + "]"
    return """<!DOCTYPE html>
<meta charset="utf-8">
<title>AVIF picture 兼容性测试</title>
<style>
 body{font:14px/1.6 system-ui;background:#111;color:#eee;padding:24px}
 .card{border:1px solid #333;border-radius:8px;padding:12px;margin:0 0 16px}
 .row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
 .cell{min-width:0}
 .tag{font-size:12px;color:#9cf;margin:0 0 6px}
 .box{background:#222;border-radius:6px;overflow:hidden;aspect-ratio:16/9}
 .box img{width:100%;height:100%;object-fit:cover;display:block;transition:filter .4s}
 .pimg,.pimg3{filter:blur(14px)}
 .pimg-on{filter:blur(0)!important}
</style>
<h1>AVIF &lt;picture&gt; 兼容性测试</h1>
<p>三列分别是三种写法。若方案②/③ 显示不出图，说明 &lt;picture&gt; 方案在本机有问题。</p>
""" + "\n".join(cards) + """
<script>
window.__SRC__ = """ + srcs_js + """;
// blurUp 的原始实现（预载后换 src）
function blurUpOrig(imgEl, realSrc){
  imgEl.classList.add("pimg");
  imgEl.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23333'/%3E%3C/svg%3E";
  var real = new Image();
  real.onload = function(){
    imgEl.src = realSrc;
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ imgEl.classList.add("pimg-on"); }); });
  };
  real.src = realSrc;
}
var imgs = document.querySelectorAll("img[data-i]");
for (var k = 0; k < imgs.length; k++){
  (function(el, idx){ blurUpOrig(el, window.__SRC__[idx]); })(imgs[k], k);
}
</script>
</body>
"""


if __name__ == "__main__":
    sys.exit(main())
