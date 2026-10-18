# D25 · min_en_words=4 误伤 573 条英文释义

日期：2026-10
状态：**已修复（4→3）。** 现有数据一字未动。

## 怎么发现的

处理 `apply` 时发现英文边界从 4 条变成 2 条，两条消失的是：

```
raw=1  ask (for something)      ← 「申请」
raw=3  apply oneself to         ← 「专心」
```

`apply` 的「申请」和「专心」是这个词最常用的义项，被我的清洗规则杀掉了。

## 根因：4 词门槛对 WordNet 的紧凑释义太严

WordNet 的释义常是紧凑的名词短语，3 个词完全够义：

```
become   come into existence          use      a particular service
minute   a short note                 school   an educational institution
become   denote or connote            pay      be worth it
write    communicate by letter        like     be fond of
mean     denote or connote            help     be of use
see      deem to be                   place    a general vicinity
keep     retain possession of         people   fill with people
```

实测被误伤的条数与词数分布：

```
疑似误伤（3-6 词却被 4 词门槛拦下）: 573 条
   3 词: 573   ← 全部恰好 3 词，没有一条 4-6 词
   其他: 0
```

**573 条全是 3 词**，说明这正是 4 词门槛下方的一个完整切片。而 3 词的释义
`come into existence` / `a short note` / `retain possession of` 语义完全充分。

动词短语受害最重，因为它们天然短：`ask (for something)` / `give heed (to)` /
`apply oneself to` / `be of use`。而这些恰好是常用义。

## 修复

```
min_en_words: 4  ->  3     主源与补缺层同步改
```

降到 3 后那 573 条全部恢复。真正的碎片（`See Amidst.`、`let have` 这类）
由 `drop_cross_reference` 更精准地拦——它匹配的是「See + 大写词」这个结构，
而不是靠词数猜。这才是正确的判别方式：**按语义结构拦，不按长度拦**。

`apply` 的边界数从 2 恢复到 4，与现有 4 个中文义项一一对应，零合并。

## 连带影响

```
英文边界 > 12 的词: 87 -> 117
总边界数: 11727 -> 约 12300
```

多出来的 30 个高频动词正是那些「细分义项短到 4 词以下」的词 —— 按 D24 的标准，
它们是真实义项，应该保留。

## 一个方法论教训

这次的错误和 D24（把「造句难」当合并理由）是同一类：**用了一个容易量化但
不相关的指标（词数、造句难度）去替代真正该判断的东西（语义是否完整、概念是否相同）**。

`min_en_words` 当初设 4 的动机是「排除碎片」，但「碎片」和「短」不是一回事：

| 释义 | 词数 | 是碎片吗 |
|---|---|---|
| See Amidst. | 3 | 是 —— 纯互见 |
| come into existence | 3 | 否 —— 语义完整 |
| be of use | 3 | 否 —— 语义完整 |
| apply oneself to | 3 | 否 —— 语义完整 |

**长度不能判断完整性，结构才能。** 已在 spec.yaml 的注释里写明这一点。

## 当前状态

```
resegment --build: 18 词 / 66 义项
队列: done 16 / review 2 / todo 2982
句子审计: 930/930 PASS 100%
禁区: wordlist/ sentences/ build/ app/ 未改动
```