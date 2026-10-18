WordNet 3.0 —— 来源与许可
========================

下载：2026-10，经 NLTK 的 downloader 获取 wordnet 包
文件：corpora/wordnet.zip
大小：10,775,600 bytes
SHA256：CBDA5EA6EEF7F36A97A43D4A75F85E07FCCBB4F23657D27B4CCBC93E2646AB59
许可：Princeton University License（见下方摘要，允许自由使用、修改、分发）

为什么 vendor 到仓库里
----------------------
README 铁律 3 要求 `source/` 下的外部数据离线可备份。WordNet 是我们要用的
第二个外部数据源（第一个是 ecdict_snapshot.json）。只靠 nltk.download 重拉
不满足这条 —— 依赖网络，且版本可能变。有了这个 zip + 上面这个哈希，
任何人任何时候都能确认拿到的是同一份数据。

用途
----
ECDICT 的 `definition` 字段本身就是 Princeton WordNet 3.0 的逐字 synset 释义
（changelog 承认「使用 WordNet 补全约 1 万个新增单词的英文定义」）。
保留原版 WordNet 的目的是做两件事：

  1. 校验 ECDICT 的英文侧到底导入了多少 —— 实测 2859 词里 ECDICT 只有
     WordNet 义项总数的约 2/3（8439 vs 12827），缺的 35% 里有我们要的
     （author 的 writer.n.01 / generator.n.03），也有噪声（well 多 21 条）。
  2. 给 ECDICT 缺失的义位做补缺来源。

不做切分主源。WordNet 单独用会有三类噪声：专名百科条目
（stone 16 个 synsets 里 5 个是美国人名）、罕见语域义
（can = 浮标，will = 遗嘱）、固定语块（make 多出的 30 条）。
这些由 spec.yaml 的 senses_v2: 清洗开关拦截，而 ECDICT 已经替我们筛过一轮。

许可摘要
--------
Princeton University 授权条款要点（完整文本见 wordnet.zip 内 wordnet/LICENSE，
共 1625 字节）：

  "Permission to use, copy, modify and distribute this software and
   database and its documentation for any purpose and without fee or
   royalty is hereby granted, provided that you agree to comply with
   the following conditions: [...] the same copyright notice and
   statements, including the disclaimer, appear on ALL copies."

  WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.

即：可自由使用/复制/修改/分发（含收费场景），条件是所有副本都要带上
版权声明与免责声明。本仓库保留原始 zip 未修改，满足该条件。