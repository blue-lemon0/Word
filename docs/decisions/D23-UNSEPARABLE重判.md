# D23 · 按英文边界重判后，UNSEPARABLE 表有三词判错了

日期：2026-10
状态：**已撤销 3 条排除。** 现有数据一字未动。

## 这张表的判断依据本身是坏的

`pick_words.UNSEPARABLE` 累积到 28 条时，每条的判断理由都是
**「中文释义重叠度高」** —— 比如 `alternative` 写的是「三个义项都是『供替代的选择』的变体」。

但**中文释义重叠度高，恰恰是旧切分算法造出来的假象**。

旧算法按逗号切 ECDICT 的 `translation`，把同义词平铺成并列的义项：
```
alternative  n. 供替代的选择, a. 两者择一的, a. 供选择的
                          ↑ 这三条在中文里都含「选择」，看起来同义
```
但英文侧根本不是这么切的：
```
raw=0  necessitating a choice between mutually exclusive possibilities   ← 必须二选一
raw=1  pertaining to unconventional choices                             ← 另类的选择
```

**「必须二选一」和「另类的选择」是两个完全不同的意思** —— 前者说宾语必须在两个互斥
选项间取舍（an alternative fuel source），后者说这个选择本身不传统
（alternative lifestyle）。造句完全能区分。

**用中文重叠度判断义项是否可分，等于用「切错了的结果」去论证「不该修」。**

## 已撤销的 3 条

```
alternative  英文 raw=0「必须二选一」vs raw=1「另类的选择」，语义完全不同
             且名词义「供替代的选择」走补洞后是 3 个可教义项，不是 1 个
file         英文 file.n.01「一套文件」/ file.n.02「器具、锉刀」/
             file.v.01「提出控告」，三类场景无重叠
soldier      英文 soldier.n.01「士兵」/ soldier.v.01「忍受疼痛、做苦工」，
             动词义线索极强（soldier on 继续忍耐下去）
```

已在 `pick_words.py` 里把 value 改成 `None` 并写明理由，
`resegment.py` 的 `active_skip()` 会跳过 `None` 条目。

## 但有一条保留了

```
frequent  「时常发生的 = 频繁的」——英文也只有 frequent.a.01 一条，确认分不开
```

英文侧同样收成一个义位，说明这词确实分不开，保留排除。

## 一个更重要的原则问题

你 2026-10 说过：

> 「如无必要，尽可能不要过滤单词，尤其是不要在代码里黑盒过滤；
> 如果我背单词遇到了觉得没必要或太简单，我直接标记学会了就行」

**按这个原则，`UNSEPARABLE` 这张表本身就是该被质疑的东西。**

它是一张**手工维护的、藏在代码里的黑名单**，而且：
- 判断依据（中文重叠度）已被证明不可靠
- 28 条全部基于旧切分算法的产物
- 唯一作用是「让产线少做事」，而少做的事用户自己可以标记掉

我这一轮撤销的 3 条，说明这张表至少有 3/28 = 11% 是错的。
**剩下 25 条我没验证，但它们用的是同一个不可靠的判断依据。**

两个选择：

| | 做法 | 后果 |
|---|---|---|
| A | 全部重判一遍英文边界 | 工作量：25 词 × 看英文释义，几小时。但彻底解决 |
| B | 保留表但降级为「提示」 | `pick_words` 不再跳过，只在输出里标注「此词义项可能不可分」 |

我倾向 **A**，理由和上面一样：这张表的判断依据已经不成立，留着就是留着一个
「看起来在过滤、实际上依据是错的」的黑盒。而且工作量的前提是——**词条本身仍会出卡**，
只是不做例句，成本很低。

## 顺带：铺开用的施工单

新增 `content-kit/pipeline/resegment_queue.py`，把「2927 个词手工处理」变成可管理的队列：

```
$ python content-kit/pipeline/resegment_queue.py --report
   todo      2988 词     待写 decisions
   done        10 词
   review      2 词      疑似同义待判断
   audit       0 词      账目不完整（会静默丢义项）
英文边界数 > 12 的词: 87
   cut(47), break(37), call(30), play(30), carry(29) ...

$ python content-kit/pipeline/resegment_queue.py --queue todo 50   # 取下一批 50 词
```

`audit` 这一类是**守卫的镜像** —— 它检查的正是「会不会静默丢义项」，
即 D18 里加的那个账目守卫的预期效果。出现 audit 就说明某个 decisions 写漏了。

## 本轮新增词条（4 词 / 12 义项）

`ability` `adopt` `advantage` `affair` `alternative` —— 覆盖四种典型形态：

| 词 | 现有→v2 | 演示了什么 |
|---|---|---|
| ability | 3→2 | 中文三义 overlap 1.00 → 按英文边界合并为两义 |
| adopt | 4→4 | 英文 3 边界 + 补洞 1（accept 归 accept.v 首词规则排除）|
| advantage | 4→4 | 含 tennis 专用义位（对考研零价值但确有此义，保留）|
| affair | 3→3 | 「事务」英文归 matter.n.01，走补洞保留 |
| alternative | 3→3 | **撤销 UNSEPARABLE 排除**，并补回名词义 |

## 当前状态

```
resegment.py --build: 12 词 / 49 义项
句子审计: 930/930 PASS 100%
禁区: wordlist/ sentences/ build/ app/ 未改动（app/README.md 等是你自己的改动）

新增: content-kit/pipeline/resegment_queue.py
      docs/decisions/D23-UNSEPARABLE重判.md
```

## 下一步（我继续，不需要你决策）

1. 按队列铺开 T1 普通词（378 词里边界 ≤5 的那些不需要人工合并判断）
2. `build_bundle.py:152` 哈希加 `glossEn`+`pos` —— **这个需要你拍板**，
   因为它会触发全量索引重建，是发布动作的范畴