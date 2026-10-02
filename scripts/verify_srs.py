# -*- coding: utf-8 -*-
"""验证 03-记忆曲线 里的 ease_factor 公式与推演表是否真的算得出来。"""
import sys
sys.stdout.reconfigure(encoding="utf-8")


def ease_factor(d):
    v = 1.50 - 0.12 * (d - 1)
    return max(0.35, min(1.50, v))


def interval_days(S, D, grade):
    ef = ease_factor(D)
    if grade == 5:
        return S * ef
    if grade == 4:
        return S * ef * 0.7
    if grade == 2:
        return S
    return max(0.25, S * 0.4)


print("=== ease_factor 斜坡 ===")
for d in range(1, 11):
    print("  D=%2d -> %.2f" % (d, ease_factor(d)))
print("单调递减:", all(ease_factor(d) > ease_factor(d + 1) for d in range(1, 10)))

print("\n=== §3 初始参数 ===")
init = [("主义 s1", 2.0, 5.0), ("TRAP", 0.8, 7.0),
        ("单义", 1.2, 6.0), ("新词", 0.6, 8.0)]
for name, s0, d0 in init:
    print("  %-8s S0=%.1f D0=%.1f ef=%.2f" % (name, s0, d0, ease_factor(d0)))

print("\n=== 连对 4 次（grade=5）间隔演化 ===")
print("%-8s %7s %8s %8s %8s %8s" % ("类型", "S0", "第1次", "第2次", "第3次", "第4次"))
for name, s0, d0 in init:
    S = s0
    row = []
    for _ in range(4):
        iv = interval_days(S, d0, 5)
        row.append(iv)
        S = S * (1 + ease_factor(d0))
    print("%-8s %7.1f %8.1f %8.1f %8.1f %8.1f" % (name, s0, row[0], row[1], row[2], row[3]))

print("\n=== 档间差距（TRAP 应显著低于 s1）===")
S1, D1 = 2.0, 5.0
ST, DT = 0.8, 7.0
a, b = S1, ST
for i in range(6):
    if i:
        print("  第%d次后  s1=%.2f天  TRAP=%.2f天  比值=%.2fx"
              % (i, a, b, a / b))
    a = a * (1 + ease_factor(D1))
    b = b * (1 + ease_factor(DT))

print("\n=== 掌握门槛 90 天需几次 ===")
for name, s0, d0 in init:
    S, n = s0, 0
    while S < 90 and n < 40:
        S *= (1 + ease_factor(d0)); n += 1
    print("  %-8s 需连对 %d 次 (S=%.0f天, D=%.1f)" % (name, n, S, d0))

print("\n=== 下界检查 ===")
print("  WRONG 后最小间隔: %.2f 天 (应 >= 0.25)" % max(0.25, 0.3 * 0.4))
print("  新词 WRONG 后: %.2f 天" % max(0.25, 0.6 * 0.4))
