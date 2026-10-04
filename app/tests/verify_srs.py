# -*- coding: utf-8 -*-
"""验证 03-记忆曲线 里的 ease_factor 公式与推演表是否真的算得出来。

参数不再硬编码在这里 —— 唯一真相源是 app/config/srs_params.tsv，
与 app/srs.mjs 读的是同一份文件。
scripts/e2e_loop.mjs 会把本脚本输出的连对 4 次向量逐格比对，
所以将来移植到 Kotlin 时有一份可对照的数值基准。
"""
import io, os, sys

sys.stdout.reconfigure(encoding="utf-8")
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # = app/
PARAMS = os.path.join(APP, "config", "srs_params.tsv")


def load_params(path=PARAMS):
    p = {}
    with io.open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2 or not parts[0].strip():
                continue
            try:
                p[parts[0].strip()] = float(parts[1])
            except ValueError:
                p[parts[0].strip()] = parts[1]
    return p


P = load_params()


def ease_factor(d, p=P):
    v = p["EF_A"] - p["EF_B"] * (d - 1)
    return max(p["EF_MIN"], min(p["EF_A"], v))


def interval_days(S, D, grade, p=P):
    ef = ease_factor(D, p)
    if grade == p["GRADE_FAST"]:
        return S * ef
    if grade == p["GRADE_SLOW"]:
        return S * ef * p["SLOW_FACTOR"]
    if grade == p["GRADE_PEND"]:
        return S
    return max(p["INTERVAL_FLOOR"], S * p["S_WRONG"])


def drift_d(D, grade, p=P):
    """难度漂移。03 §4.2 写的公式是 +D_DRIFT*(grade-4)，那会让答对把 D 推高、
    答错把 D 拉低，与该节自己的注解相反；实现按注解取 4-grade。"""
    return max(1.0, min(10.0, D + p["D_DRIFT"] * (4 - grade)))


print("=== 参数来源: app/config/srs_params.tsv ===")
print("  S0_TRAP=%.2f S0_MULTI_S1=%.2f S0_SINGLE=%.2f S0_NEW=%.2f S0_RARE=%.2f"
      % (P["S0_TRAP"], P["S0_MULTI_S1"], P["S0_SINGLE"], P["S0_NEW"], P["S0_RARE"]))
print("  MASTER_S=%.0f MASTER_REPS=%.0f MASTER_STREAK=%.0f"
      % (P["MASTER_S"], P["MASTER_REPS"], P["MASTER_STREAK"]))

print("\n=== ease_factor 斜坡 ===")
for d in range(1, 11):
    print("  D=%2d -> %.2f" % (d, ease_factor(d)))
print("单调递减:", all(ease_factor(d) > ease_factor(d + 1) for d in range(1, 10)))

print("\n=== §3 初始参数 ===")
init = [("主义 s1", P["S0_MULTI_S1"], P["D0_MULTI_S1"]),
        ("TRAP", P["S0_TRAP"], P["D0_TRAP"]),
        ("单义", P["S0_SINGLE"], P["D0_SINGLE"]),
        ("新词", P["S0_NEW"], P["D0_NEW"]),
        ("低频", P["S0_RARE"], P["D0_RARE"])]
for name, s0, d0 in init:
    print("  %-8s S0=%.1f D0=%.1f ef=%.2f" % (name, s0, d0, ease_factor(d0)))

print("\n=== 连对 4 次（grade=5, D 固定不漂移）间隔演化 ===")
print("%-8s %7s %8s %8s %8s %8s" % ("类型", "S0", "第1次", "第2次", "第3次", "第4次"))
vectors = {}
for name, s0, d0 in init:
    S = s0
    row = []
    for _ in range(4):
        row.append(interval_days(S, d0, P["GRADE_FAST"]))
        S = S * (1 + ease_factor(d0))
    vectors[name] = row
    print("%-8s %7.1f %8.2f %8.2f %8.2f %8.2f" % (name, s0, *row))

print("\n=== 档间差距（TRAP 应显著低于 s1）===")
S1, D1 = P["S0_MULTI_S1"], P["D0_MULTI_S1"]
ST, DT = P["S0_TRAP"], P["D0_TRAP"]
a, b = S1, ST
for i in range(6):
    if i:
        print("  第%d次后  s1=%.2f天  TRAP=%.2f天  比值=%.2fx" % (i, a, b, a / b))
    a = a * (1 + ease_factor(D1))
    b = b * (1 + ease_factor(DT))

print("\n=== 掌握门槛 %.0f 天需几次（含难度漂移）===" % P["MASTER_S"])
for name, s0, d0 in init:
    S, D, n = s0, d0, 0
    while S < P["MASTER_S"] and n < 40:
        iv = interval_days(S, D, P["GRADE_FAST"])
        S = S * (1 + ease_factor(D))
        D = drift_d(D, P["GRADE_FAST"])
        n += 1
    print("  %-8s 需连对 %2d 次 (S=%.0f天, D=%.1f)" % (name, n, S, D))

print("\n=== 难度漂移方向（03 §4.2 按注解实现）===")
base = 5.0
for label, grade in [("FAST=5", P["GRADE_FAST"]), ("SLOW=4", P["GRADE_SLOW"]),
                     ("PEND=2", P["GRADE_PEND"]), ("WRONG=0", P["GRADE_WRONG"])]:
    d = drift_d(base, grade)
    if grade == P["GRADE_WRONG"]:
        d = drift_d(d, grade)   # WRONG 还有一次 D_WRONG_BUMP
    print("  %-8s D %.1f -> %.2f  (ef %.2f -> %.2f)"
          % (label, base, d, ease_factor(base), ease_factor(d)))
print("  期望：答得越轻松 D 越低、间隔越长")

print("\n=== 下界检查 ===")
print("  WRONG 后最小间隔: %.2f 天 (应 >= %.2f)"
      % (max(P["INTERVAL_FLOOR"], P["S_MIN"] * P["S_WRONG"]), P["INTERVAL_FLOOR"]))
print("  新词 WRONG 后: %.2f 天" % max(P["INTERVAL_FLOOR"], P["S0_NEW"] * P["S_WRONG"]))
print("  主义 s1 WRONG 后: %.2f 天"
      % max(P["INTERVAL_FLOOR"], P["S0_MULTI_S1"] * P["S_WRONG"]))

print("\n=== 黄金向量（scripts/e2e_loop.mjs 逐格比对这份）===")
for name in ("主义 s1", "TRAP", "单义", "新词"):
    print("  %-8s %s" % (name, [round(x, 2) for x in vectors[name]]))