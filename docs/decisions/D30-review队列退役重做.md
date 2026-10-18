# D30 · review 队列退役重做：从「词树相似」换成「产出义项是否分不开」

日期：2026-10
状态：**已生效。** review 队列首次归零。

## 为什么必须换

review 队列用 `separability_flags()`，判据是 WordNet `path_sim >= 0.75`，
比对对象是**全部英文边界**。量出来两个致命问题：

### ① 0.80 是同 synset 族相邻义项的结构性地板

```
crime   an act punishable by law          || an evil act not punishable by law   0.80
agent   an active and efficient cause     || a substance that exerts some force  0.80
affect  have an effect upon               || act physically on; have an effect   0.80
argue   present reasons and arguments     || give evidence of                    0.80
```

这四条**全是我有意保留的真区分**。判别句都成立：

```
Murder is a crime, but greed is not.
The agent of change / a cleaning agent
have an effect on / act physically on
argue for a policy / the facts argue against
```

也就是说 **path_sim 根本分不开它们** —— 不是阈值定高了，是这个信号
在这里已经饱和。阈值降到 0.1 也照样全是这些对。

### ② 比的是边界，不是产出义项

```
review 6 个，其中 3 个是纯噪音：
   affect / argue / agent
   —— 那是我「合并成一条义项」的两个边界，被报成「疑似同义」
```

后果有两层：已完成的词永远清不掉 review，**真正的待办被稀释**。
一个永远亮着的告警等于没有告警。

## 新判据：直接对准用户最初的抱怨

用户的问题是「为什么有相似义项」——**学习时分不开**。
所以判据应该是「这两条产出义项，用户分得开吗」，而不是「这两个 synset 像不像」。

```
en_jac >= 0.60   两条义项的英文释义词级重合 60% 以上
zh_jac >= 0.50   两条义项的中文释义 2-gram 重合 50% 以上
```

对**产出义项**两两比对（`decision_senses()` 解析出与 build 完全一致的那份产出，
避免「队列报的差异在 build 里不存在」这类不一致）。

## 阈值是定标出来的，不是拍的

先造合成正/负例，再扫真实数据：

| en 阈值 | 正例命中 | 负例误报 | 说明 |
|---|---|---|---|
| 0.50 | 3/3 | **1/3** | crime/罪恶 误报 |
| **0.60** | **3/3** | **0/3** | **取这个** |
| 0.70 | 2/3 | 0/3 | 漏掉 en_jac=0.667 那条 |
| 0.80 | 2/3 | 0/3 | 同上 |

```
真实数据（74 个已产出词）误报: 0
```

正例覆盖三种真实形态：英文释义完全相同、中文语序不同但英文相同、
英文只差一个词（en_jac=0.667）。

## zh 判据为什么必须留着

**`fromZh` 义项的 `glossEn` 是空的。** 两条 ZH-FALLBACK 义项之间
`en_jac` 恒为 0（空集与空集的 jaccard 没定义，取 0），
只有中文判据兜得住。这类义项现在有 20+ 条（expert/central/chance/seed…），
不是边角情况。

## 定标流程本身比结论更值得记

写守卫时容易直接拍一个「看起来合理」的阈值，然后被自己的数据打脸
（这里若拍 0.75，`have an effect upon` vs `have an effect upon the result`
会漏报；拍 0.5，crime 会误报）。

固定流程：

```
1. 造合成正例（各种「本该被抓住」的形态）+ 负例（各种「本该放过」的真区分）
2. 扫阈值网格，找「正例全中且负例零误报」的区间
3. 再上真实数据确认误报率
4. 把这张表写进 spec 注释
```

第 3 步不能省：合成例是我自己想的，可能不代表真实分布。

## `separability_flags` 保留但已移出队列

`path_sim` 还有别的用途（比如 `--plan` 里提示义项可判别性），所以函数留着，
只是不再当队列判据。删掉更干净，但留着能保住「可判别性」这个信号本身。

## 当前状态

```
resegment --build: 74 词 / 198 义项
队列: done 74 / review 0 / todo 2926
句子审计: 33/33 PASS 100%
禁区: wordlist/ sentences/ build/ app/ 未改动
```

队列现在只有三个状态：`done` / `audit`（账目不完整的硬错误）/ `todo`。