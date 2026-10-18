# D31 · min_en_words 3→2：892 条被误杀的释义里，739 条是真义项

日期：2026-10
状态：**已生效。** 已产出的 136 词全部重新验证通过。

## 触发

连续三个词撞上同一件事，都是「释义完整却被长度门槛挡掉」：

```
brain.n.02  mental ability            「智力」   have brains
elect.v.02  choose                    「选择」   He elected to stay
lay.v.04    lay eggs                  「下蛋」   birds lay eggs
```

三次都靠 `_wordnet_exceptions` 逐个捞。第三次时意识到：**这不是个例，
是被门槛系统性误杀的量还没被数出来。**

## 数量：892 条

```
主源(ECDICT) 仍被丢弃 320 条
补缺层(WordNet) 仍被丢弃 572 条
合计 892 条，涉及约 700 个词
```

样本几乎全是完整义项：

```
alive     a. possessing life        absorb    v. become imbued
ask       v. inquire about          address   v. speak to
anger     v. make angry / become angry       bear  v. have
air       v. be broadcast           accelerate v. move faster
ancient   a. very old               advantage v. be of advantage to
```

按词数分：

```
2 词: 739 条   <- 界面上可读，恢复
1 词: 153 条   <- have / remove / define / let have，界面上没信息量，留下
```

## 为什么停在 2 而不是降到 1

1 词释义恢复进来，卡片上会出现 `glossEn = "have"` —— 用户看到这个词学不到
任何东西，`glossZh` 得独自承担全部信息。而 2 词那批（`possessing life` /
`inquire about` / `make older`）是可读的。

**边界数 12641 → 13133（+3.9%），换来 739 条真义项。**

## 再次印证 D25：碎片靠结构拦，不靠长度拦

```
892 条里互见碎片只有 1 条（See Amidst.）
```

`drop_cross_reference` 匹配的是「See + 大写词」这个结构，早就把真正的碎片
拦掉了。长度门槛在这一层是**冗余且有害的** —— 它拦下的绝大多数不是碎片，
是 WordNet 的紧凑写法。

```
See Amidst.      3 词   碎片   <- 该拦（由 drop_cross_reference 拦）
possessing life   2 词   完整   <- 不该拦（被误杀 892 次的典型）
become imbued     2 词   完整   <- 同上
```

## 顺带暴露一个真 bug：例外 synset 把跨源去重也绕过了

阈值放开后 `english_units` 里出现同一释义两次：

```
lay     lay eggs ×2      impose as a duty ×2
brain   mental ability ×2
```

原因是 D28 的去重判断写成了 `if key in known and not is_exc` —— 例外同时
豁免了「过滤」和「去重」两件事。

**但例外的目的是「救回 ECDICT 漏掉的义项」，不是「制造副本」。**
若 ECDICT 已经有了这条定义，再放一份 WordNet 副本只会让同一个意思
在 plan 里出现两次。修正：

```
例外豁免：lexname / drop_patterns / usage_domains / min_en_words   ← 保留
例外豁免：跨源去重                                              ← 取消
```

修正后守卫精确指出 `brain`/`lay` 三处引用失效，改引 ECDICT 侧的行号即可。
这说明守卫在起作用：它不是「报个错让人猜」，而是**逐条列出哪个 raw 不存在**。

## 方法论：这次的教训是「三次例外就该去数总量」

前两次 `too_short` 事件（brain、elect）我都用 `_wordnet_exceptions` 单独
救了。第三次（lay）才去数全库。

**代价对比：**
- 逐个救：每次要查 synset 名、改 decisions、重建，且只能救我想得到的词
- 数总量：一次扫描就知道是 892 条，而且答案直接指向「门槛本身错了」

规则：**同一个原因导致第二次失败时，就去数这个原因的总规模，
不要继续用逐个打补丁的方式。**

## 当前状态

```
resegment --build: 136 词 / 388 义项   （全部通过）
候选: 2998 词 / 13133 英文边界
队列: done 136 / review 0 / audit 0 / todo 2864
句子审计: 33/33 PASS 100%
禁区: wordlist/ sentences/ build/ app/ 未改动
```