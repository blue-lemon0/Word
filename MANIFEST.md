# MANIFEST

这个仓库是什么、每个文件是什么、怎么跑起来、去哪改什么。
**先读 [README.md](README.md) 上手，读本页查台账；两侧交接格式读 [CONTRACT.md](CONTRACT.md)。**

## 一句话

**应用正式名：极简单词**（旧名「词库」只出现在历史文档与包名 `com.wordbank.*` 里）。
图标源文件：`app/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`（600×600 裁掉四周留白后生成）。


应用优先：`app/` 是背单词应用 —— 界面在 `app/web/`（Vue 3 + IndexedDB，离线可用），
学习进度与内容编辑都在浏览器本地。内容靠 **AI 生成 + 手动添加**（AI 助手已渗透
多个页面），原内容产线 `content-kit/` 与历史归档 `archive/` 已于 **2026-10-20
整体删除**（git 历史 bfda5d7 之前的任意提交都有全量，可随时恢复）。

## 跑起来

```bash
cd app/web; npm install; npm run dev     # -> http://127.0.0.1:5180/
```

应用无后端：数据全在 IndexedDB，离线可用；打 Android 包用 `npm run apk`。

## 仓库结构

```
build/         派生产物（交接区），整个 gitignore；cards.json 是本机历史产物
  bundle/cards.json              内容包，运行时唯一输入（word-bundle v1，见 CONTRACT.md）
  bundle/cards_v2.json           WordNet 重切验证包（独立锚点体系）

app/           背单词应用
  web/                          **当前应用**：Vue 3 + Dexie（界面/数据层/备份）
    src/types.ts db.ts edit.ts   数据模型与内容编辑（义项 id 是内部 UUID，永不变）
    src/srs.ts                   app/srs.mjs 的逐函数移植（数值必须一致，有测试）
    src/quiz.ts importer.ts      出题与导入对比；import.ts 吃两种 JSON
    src/backup.ts                word.backup v2 导出/恢复 + 自动快照回滚
    src/sentence-health.ts       单句义项的健康线（每义项 2 句）
    src/pages/                   首页 单词页 意思页 词库 训练 错题板 更多
    src/components/              QuestionBox / TrainSession（整轮训练本体）/ ScanList 等共用组件
    public/seed.json             首次启动的种子（cards_v2.json 副本）
    tests/                       srs_parity / flow_smoke / schema_upgrade / perf_probe / pwa_check / cdp / screencast_frames / overscroll_probe
    prototype-v4.html + proto.js 设计原型，定稿是 v4（UI 照它做的）
    DEBUG-RUNBOOK.md             真机排查手册（崩溃/卡死/日志/CDP 的坑）
  android/                      Android 壳（WebView + assets 映射），`npm run apk` 一条命令打包安装
    keystore.properties.example  release 签名配置模板（真实 properties / keystore 不入库）
    app/proguard-rules.pro       release R8 规则（保留 @JavascriptInterface 桥方法）
  srs.mjs                        SRS 参照实现（web 版 srs.ts 的逐格基准）
  config/srs_params.tsv          SRS 参数唯一真相源（web 侧 JSON 由它生成）
  tests/verify_srs.py            SRS 参数基准（黄金向量）

scripts/verify_docs.py           结构守卫
docs/                            设计文档（design/03、05）与决策记录（decisions/D32+）
```

依赖方向：`内容包 → app`，只向下。`build/` 不含手写内容。

### 归属规则（都能机械检查，scripts/verify_docs.py 守门）

1. **一个事实只存一处。** 义项只存应用库（IndexedDB，导入走 `importBundle()`）。
   曾有散 TSV 与中间 JSON 双份的时期，已于 2026-10 统一并随产线删除。
2. **派生只向下。** 内容包是只读输入，应用数据（内容/进度/历史）在 IndexedDB。
3. **真相源可读**：内容包 JSON 字段全称，schema 见 CONTRACT.md。
4. **派生产物全部 gitignore**：`build/`、`app/state/`、`__pycache__/`。

## 代码分工

| 位置 | 职责 |
|---|---|
| `app/web/src/` | **当前 UI 与数据层**：Vue 页面 + Dexie 数据模型 + 内容编辑 + 出题 + 备份 |
| `app/web/src/srs.ts` | `app/srs.mjs` 的逐函数移植；`tests/srs_parity.mjs` 逐格比对，不一致就红 |
| `app/web/src/importer.ts` | 导入差异计算（只读）+ 按逐条决策写库；默认保留本地释义 |
| `app/web/src/flags.ts` | 问题句标记：清单导出（word-flags v1）、关单、导入替换时保留标记 |
| `app/srs.mjs` | SRS 引擎（参照实现），读 `app/config/srs_params.tsv` |
| `scripts/verify_docs.py` | 结构守卫：布局、契约字段、前端四条设计判断 |

## 常用命令（均从仓库根运行）

```bash
node app/web/tests/srs_parity.mjs    # SRS 移植一致性
node app/web/tests/flow_smoke.mjs    # 数据层端到端（185 条行为断言）
python app/tests/verify_srs.py       # SRS 参数基准
python scripts/verify_docs.py        # 结构守卫

# AI 体检的真机驱动（会花钱：每个词一次真实调用；缓存命中的免费）
node app/web/tests/audit_drive.mjs
```

## 当前进度

| | |
|---|---|
| 卡片 | 7884 义项 / 2998 词 |
| 有例句 | **186 义项 / 52 词 / 930 句** |
| 目标 | 300 词（约 5570 句，约 19 轮） |
| 音标 | 2998 词全覆盖 |

完整 7884 义项 = 39420 句，约 140 轮。**做不完，也不该做** —— 20 题一轮，
45 轮内容摊到几个月正是一个完整训练量。

## 已知缺口 / 历史结论

1. ~~53 条例句的 note 释义与词库对不上~~ **已修（2026-10）**。GLOSS 规则查出
   36 句在教错的义项（terrible / civil / injury / coast / grand / motor 等），
   全部重写，note 释义统一成词库 `glossZh` 原文。现在 930 句 PASS 930。
2. ~~`spec.yaml` 未被审计脚本加载~~ **已修（2026-10）**。规格反转完成，
   改规格不再碰代码，`make_spec.py` 已删除。
3. **内容产线已整体删除（2026-10-20）**：`content-kit/`（产线脚本、TSV 真相源、
   ECDICT 快照、提示词）与 `archive/`（pre-ECDICT 快照、已完成管线、不可运行
   ETL、旧决策台账）全删。git 历史 `bfda5d7` 之前的任意提交都有全量，恢复：
   `git checkout bfda5d7 -- content-kit archive`。
   产品转向「AI 生成 + 手动添加」，内容侧不再有活跃脚本。
6. `civil` 的「市民的 / 公民的」两个义项中文近乎同义，判别价值低（原
   `pick_words.py` 的 `UNSEPARABLE` 表记过一笔；该表已随产线删除，git 历史可查）。
7. 2026-10 双子系统拆分：原 `scripts/`（内容脚本）、`data/`、`source/`、
   `prompts/` 归入 `content-kit/`；应用件归入 `app/`；内容包字段从单字母
   缩写（w/s/zh/rows/t/k/…）改为全称，并加 `format`/`schemaVersion` 守门，
   格式见 CONTRACT.md。
8. **2026-10 应用搬到浏览器端**：`app/web/` 从单文件原型重写成 Vue 3 + Dexie
   （数据落 IndexedDB，离线可用，不再需要 Node 服务）。随之三处变了：
   学习进度锚点从 `word#senseId` 换成**义项内部 UUID**（插删改序义项不再让
   进度错位）；备份格式换成 `word.backup` v2（旧的 `word-progress` v1 不通用）；
   旧服务端骨架（`server.mjs`/`db.mjs`/`schema.sql`/`tools/`）已于 2026-10-22
   整体删除，移植所需的数据模型参照收进 `docs/design/05`。
   现行规格见 [docs/DESIGN-词库系统v2.md](docs/DESIGN-词库系统v2.md)。
9. **句标记闭环已打通（2026-10-17）**：浏览器端把问题句导出成 `word-flags` v1
   （错题板 → 导出清单），交人工或 AI 修（原 `triage_flags.py` 已随产线删除），
   修好后回错题板点「已修好」关单。
   导入替换例句时按原文保留标记，避免「只改译文」的修复让标记悄悄消失。
10. **答完能查词 + 可选 AI（2026-10-19）**：
   - 训练页答完这一题后，句子里**每个词**都能点开：浮层看义项（带例句数）、
     进义项/词条详情；不在库里的词可当场加入（建词条 + `needsRefine` 占位义项）。
     答之前不可点 —— 这道题问的就是这个词的意思（D37，查词 5 项守卫 + 13 条断言）。
   - AI 助手（D38）：可选、默认关闭、代码全在 `app/web/src/ai/`，
     只产出提案、落库由人点「应用」（应用前自动存内容快照）。
     四个动作：整词审查、**空壳词补全**（义项 + 例句一起提）、补 3 条候选例句、换掉某一句；
     协议是 OpenAI 兼容的 `/chat/completions`（DeepSeek 只是默认值），
     手机走原生 `NativeBridge.httpPost`（WebView 的 fetch 会被 CORS 拦），
     结果按「内容指纹 + 模型名」缓存 —— 内容不变不重复花钱。
     Key 存本机 localStorage、**不进备份**；填了 Key 自动开开关，入口可见性用共享的 `aiReady`。
     守卫 12 项（只在 ai/ 里、只提议不写库、幻觉绑定、缓存键含指纹、Key 不进备份、
     原生网络、入口不出现、快照、重算高亮、空壳分流、例句跟义项走、Vant 组件都注册过），
     断言在 `flow_smoke` 里用注入的假传输跑全链路。
     **真机已用真实 key 跑过三条路**：审查（1005 tokens）、换一句（975）、补全（984）。
   - 代价：Android 壳因此需要 `INTERNET` 权限（没有它只会得到
     「连不上 AI 服务」，看起来像网络问题）。
11. **AI 的三个尺度（2026-10-19 深夜）**：现场修一句（D39，训练页「有问题？改」里
   直接让 AI 换掉这句）、整词审查/补全（D38，词条页）、整库体检（D40，更多 → AI 体检）。
   体检是二级页：逐词串行、逐词确认、随时能停；**进度就是缓存**，
   跑过的词再跑 0 花费；排序是「需精修 > 缺音标 > 例句少」。
    为此提议类型扩到五种：改释义（含熟词僻义 `trap`）、补音标（`word.update`）、
    补例句（跟义项一起提）、换例句、加义项/例句。
12. **单句义项批量补句（2026-10-21）**：词库页「补例句」只扫当前单句义项，
    每个义项补到 2 句（`sentence-health.ts` 是唯一判定口径）；一条提案里
    `sense.update` 也带 `sentences[]`，任一义项不够就整份拒绝（全有或全无）。
    预览可取消整组、可中途停止，已应用的保留；每组的成功/失败都汇总。
13. **训练页返回保进度 + 释义显式编辑（2026-10-21）**：从词条/意思详情返回
    训练页时用 `fromDetail` 跳过 query watcher，保留 `queue/steps/cursor`，
    不再重置整轮；中文释义默认只读，点右侧铅笔才进入编辑，完成或失焦保存。
14. **正式包签名演练（2026-10-21）**：release 签名从
    `app/android/keystore.properties` 读取，真实密钥与密码在仓库外；
    `npm run apk:release` 产出签名 APK + AAB，默认不安装。release 开 R8，
    `proguard-rules.pro` 显式保留 `NativeBridge` 的 `@JavascriptInterface` 方法。
    发布前必须先定最终项目名/应用名/`applicationId`，详见
    [docs/RELEASE-SIGNING.md](docs/RELEASE-SIGNING.md)。
15. **提示词可在应用内改（2026-10-22）**：8 块提示词（共用审校规则、输出 JSON 形状、
    审查 / 补例句 / 换句 / 补全 / 判原形、复制给 AI 的模板）的默认文本与「用在哪」
    都在 `app/web/src/ai/prompt-registry.ts`；用户改过的版本存在本机
    `app/web/src/ai/prompt-store.ts`（localStorage，不进备份），界面是
    更多 → 提示词管理。改完**立即生效**：`prompts.ts` 每次调用现场读模板，
    缓存键含提示词指纹，旧结果自动不再命中。模板里的 `{{变量}}` 由代码填
    （词条内容、编号），保存时校验必需变量与未知变量名。
16. **90 天复习量预测（2026-10-24）**：首页「扫读」tab 底部钉着一条
    预测（默认收起成一行摘要，点开是 90 天柱状图）。推演在
    `app/web/src/forecast.ts`：把每天到期的卡喂给与真实作答同一套
    `applyReview`，按「每天都练、全部普通速度答对」口径滚出下一次到期；
    天粒度、不含闲置衰减、按词去重（与首页统计同口径）。图组件
    `app/web/src/components/ForecastBars.vue` 自绘（不引图表库）。
    行为测试在 `app/web/tests/forecast.mjs`（已挂进 `npm test`）。
17. **提前复习打折（2026-10-24）**：没到期就答对（首页随机刷到），稳定度增长
    按「已等待时间 / 计划间隔」打折，到期或逾期才满额 —— 否则一周内反复
    刷到同一张卡可满额连涨、几天速成「掌握」，从未经历长间隔考验。
    实现在 `applyReview` 的新参数 `prevDueAtSec`（TS 与 `app/srs.mjs`
    参照实现同步，`srs_parity.mjs` 4800 格对拍 + 专项断言看守）。
    配套：首页随机队列把 24 小时内答过的卡排到最后（`buildRandomQueue`），
    刚练过的优先让位；池子不够时按 last_review 从旧到新补足，队列不为空。
18. **首页 = 平级 tab（2026-10-25）**：背单词本体从 `pages/TrainPage.vue` 抽成
    `components/TrainSession.vue`，直接嵌进首页「复习 / 学习」tab
    （与 /train 同一判分链路）；原首页两屏降为「随便刷 / 扫读」两个 tab。
    默认落点：有到期 → 复习，无到期有待学 → 学习，都没有 → 随便刷；
    数量为 0 的 tab 整个隐藏，显隐只在进入首页时刷新（打完一轮不立即隐藏，
    免得吞掉结算屏）。顶部指示器换成胶囊 tab 条，扫读底部两颗大按钮删除
    （入口已上 tab 条）。`/train` 只剩薄壳：顶栏 + TrainSession，
    词库「练这组」仍跳它。

## 决策记录

产线时代的 D15–D31 与旧设计（design/01/02/04）已随产线删除（git 历史可查）。
现行决策：`docs/decisions/` D32+ ——
D32（应用搬到浏览器端：技术栈与义项 UUID 锚点）、
D33（交互保护：例句显式编辑态、确认走自己的弹层、返回语义）、
D34（固定栏与橡皮筋：要栏不动就得不要橡皮筋，窗口层位移网页管不了）、
D35（信息架构：二级页不摆底栏 + 三个记录列表合成可滑动的三面板）、
D36（训练是一个动作不是一个地方：撤出底栏 + 扫读并进训练页 +
训练时当场改内容 + 干扰项按词性挑且同词优先）、
D37（答完之后才许查词：句子里每个词可点，未入库可就地加入）、
D38（接 AI：可选插件，只产出提案、落库永远由人点；OpenAI 兼容协议、
手机走原生网络、结果按内容指纹缓存省钱）、
D39（训练页也能换句：AI 要放在「发现问题的现场」）、
D40（整库体检：逐词串行 + 逐词确认 + 随时能停，进度就是缓存）、
D41（词库按学习进度组织：今天一张卡 + 五个桶，桶能直接开练；仓库口径降为「维护」）、
D42（加一个词一步到「能背」：配了 AI 就生成义项与例句，已在库就给「去这个词」）、
D43（训练页的返回栈：同一页内部的切换用 replace；扫读点一行先给答案再问练不练）、
D44（首页 = 随手背一句：卡上直接「点一下看意思」，删掉搜索框与重复的训练入口）、
D46（练习是浮层不是房间：练一句不跳页；首页内部可横滑）。

真机踩坑与判据在 [`docs/notes/踩坑记录.md`](docs/notes/踩坑记录.md)（82 条），
其中可机械判定的一部分挂在 `scripts/verify_docs.py` 的「真机交互守卫」里
（166 项）：这些坑都不报错，只能靠断言拦住。

守卫的**边界**要说清楚：它判的是源码文本的形状，不是行为。
所以「某功能有没有生效」只能靠断言结果的测试（本项目已有 185 条，
在 `app/web/tests/flow_smoke.mjs`）或真机量测：
「屏幕上有没有闪」用 CDP `Page.startScreencast` 逐帧抓（坑 42），
「栏到底动不动」用 `tests/overscroll_probe.mjs`（坑 45 / D34），
「某功能接上了没有」用 flow_smoke 里的行为断言（坑 52）。
