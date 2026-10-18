# app/web — 背单词应用（浏览器端 + Android 壳）

Vue 3 + TypeScript + Vant，数据落 **IndexedDB**（Dexie），不依赖 Node 服务端。
界面在 `app/android` 还有一个 Android 壳 —— 同一份构建产物，打成 APK 装到手机上，
**装上就离线可用**，不经过任何服务器。

内容模型与交互取舍见
[`docs/DESIGN-词库系统v2.md`](../../docs/DESIGN-词库系统v2.md)。

取代了原来的单文件原型 `app/web/index.html`（原型存档在 `prototype-v2/3/4.html`，
定稿是 **v4**）。SRS 引擎仍在 [`app/srs.mjs`](../srs.mjs) 里当参照，
浏览器版是逐函数移植，见下文「移植一致性」。

## 跑起来

```bash
cd app/web
npm install
npm run dev            # -> http://127.0.0.1:5180/  （端口写死，不会自动跳）
npm run typecheck      # vue-tsc
npm run build          # 产物在 dist/，可纯静态托管
npm run params         # 从 app/config/srs_params.tsv 重新生成 src/srs_params.json
npm run apk            # 打进 APK 并装到连着的手机（见「装到手机上」）
npm test               # SRS 一致性 + 数据层端到端
npm run test:pwa       # PWA 装配检查（manifest/图标/meta/sw）
```

> 改完前端请重新 `npm run apk`：**打包脚本每次都会重新构建**。
> 曾经写成「dist 存在就跳过」，结果一个已知修复没进包——本机 dev 正常、
> 手机上复现依旧，排查方向整个跑偏。

首次打开时若库为空，自动灌 `public/seed.json`（content-kit 的
`cards_v2.json` 副本）—— 走的是和「导入 JSON」**同一条** `importBundle()` 路径，
所以种子通了 AI 导入就一定通。正式词库在「词库 → 导入内容包」里选
`build/bundle/cards.json`。

## 装到手机上

两条路，按「要不要一个真正的 app」选：

| | Android | iPhone |
|---|---|---|
| **A. APK（推荐）** | `npm run apk` —— 连 USB 自动装，桌面出现「词库」图标 | 做不了 APK，走 B |
| **B. PWA** | 浏览器打开 HTTPS 地址 → 添加到主屏幕 | **只能用这条**：Safari 打开 → 分享 → 添加到主屏幕 |

### A. Android 壳（`npm run apk`）

```bash
npm run apk                    # 构建 + 装到已连接的手机
npm run apk -- --no-install    # 只出包：app/android/app/build/outputs/apk/debug/app-debug.apk
```

要装的只有两个东西：Android SDK 的 `platform-tools`（adb）和一个 JDK
（Android Studio 自带的 jbr 就够，脚本会找）。一条命令会做完：

```
vite build → dist 拷进 app/android/app/src/main/assets → 图标各密度
            → gradle assembleDebug → adb install
```

产物约 1.7 MB。**壳里只有 WebView + 一层 assets 映射**：

- `MainActivity.java` 用 `WebViewAssetLoader` 把 assets 挂在虚拟域名
  `https://appassets.androidplatform.net/` 下 —— **必须是 https**，
  否则 service worker、`crypto.randomUUID`、IndexedDB 都不工作。
- `ServiceWorkerControllerCompat` 必须设上：SW 自己发的请求走不到
  assets 映射，离线能力会坏。
- APK 里**不放词库**。首次打开灌 `seed.json`，正式词库在应用内导入。
  所以 APK 一直是 1.7 MB，加多少词都不变大。

### B. PWA（iPhone 只能走这条）

`dist/` 是纯静态的，丢到任何 HTTPS 托管都行（Cloudflare Pages / Vercel /
GitHub Pages 都免费）。**PWA 安装要求 HTTPS**，局域网 http:// 不行 ——
Chrome 不注册 service worker，「添加到主屏幕」只是个书签。

`node tests/pwa_check.mjs` 会机械查一遍 manifest、图标、iOS 那套 meta、
sw.js 语法 —— 这几样缺一个的表现都是「装不上」或「白屏」，而且只有真机看得见。

## 装机后的排查

**真机上出现的问题，桌面上一个都看不出来。** 这轮的排查手册在
[DEBUG-RUNBOOK.md](DEBUG-RUNBOOK.md)，最常用的三条：

```bash
adb shell pidof com.wordbank.app.debug      # 空 = app 崩了（用户说的「卡死」多半是这个）
adb logcat -b crash -d | tail             # 渲染进程崩溃的细节（-b crash 必须写）
node tests/cdp.mjs "location.hash"        # 直接问页面：URL / DOM / IndexedDB
node tests/screencast_frames.mjs "document.querySelectorAll('.sense')[0].click()" frames
                                           # 逐帧录屏：切页那一下到底闪没闪
node tests/overscroll_probe.mjs doc down  # 越界拖动：固定栏动没动（需先停在能滚的页面）
```

已实测会让 WebView 渲染进程崩溃的组件记在
[tests/WEBVIEW-CRASHES.md](tests/WEBVIEW-CRASHES.md)（目前只有 `van-dropdown-menu`），
**加新组件前先在真机上点一遍**，崩了就记进去。

### 固定栏与橡皮筋

顶栏与底部 tab 栏是 `position: fixed`，**越界拖动时它们不动如山**。
这不是「网页做不到」，是做了取舍：**要栏不动，就不能要橡皮筋**。

越界拖动时被移动的是**整个窗口**（`targetSdk ≥ 31` 默认开
`crossWindowStretchEffectsEnabled`），而 fixed 相对的是**视口**、不是窗口 ——
所以「fixed 就该不动」在这条链上是断的。两套机制、两处配置：

- `<html>`（根滚动容器）与 `.sh-b`（全站唯一的内层滚动容器）
  一律 `overscroll-behavior: none`。
  ⚠️ `contain` 不等于禁橡皮筋：它只挡「往祖先传」，**自己照弹**。
  两行挨着写时，长写 `overscroll-behavior-y` 会覆盖简写的 y 分量 ——
  注释写着 none、真机 `getComputedStyle` 量出来是 contain，这种不一致
  只有量才知道（坑 45）。
- 判据用 `tests/overscroll_probe.mjs`：`底栏 .fixed 位移 : 0 px`、
  `状态栏 .sb 位移 : 0 px`。若 DOM 数字为 0 而逐帧录屏里位置变了，
  动的是合成器/窗口，网页侧无解，要断只能在原生
  `setOverScrollMode(View.OVER_SCROLL_NEVER)`。

完整取舍见 [docs/decisions/D34-固定栏与橡皮筋.md](../../docs/decisions/D34-固定栏与橡皮筋.md)。

## 页面结构

三级：**首页（学）→ 单词页（选）→ 意思页（改）**，底部三个 tab：

| tab | 做什么 | 不做什么 |
|---|---|---|
| 首页 | 搜索、随机一个词 + 它的一句例句、跳训练 | 不显示中文释义、不放进度统计 |
| 词库 | 可搜索可筛选的词表（需精修/缺例句/T1/未掌握） | 不就地编辑 |
| 更多 | 统计、备份、快照、导入历史、回收站 | — |

**训练不在底栏里**：它是一个**动作**，不是一个地方。从首页「去训练」进，
盖满全屏、没有底栏、顶栏有返回；训练页往下滚就是「扫读例句」那一节。
理由与「为什么判断改成路由显式声明 `meta.tab`」见
[D36-训练是一个动作.md](../../docs/decisions/D36-训练是一个动作.md)。

**二级页（单词页 / 意思页 / 错题板）不摆底栏。**
底栏在手机上被读成「和我同级的几个地方」，放在详情页里会同时产生两种错误预期：
点当前高亮的项是回上一层还是不动？在二级页点另一个 tab 是替换当前页还是压一层历史？
后者要命 —— 历史会越按越长。收掉之后后退栈只有一条线：从哪来回哪去。

收底栏必须**同时收回它占的那块留白**（`style.css` 的 `html.no-tabs` 把
`--wb-tabbar-h` 归零；`.wb-page` 的 padding、首页 min-height、toast 落点全按它算），
否则页面底部会凭空多一截空白。理由与真机数字见
[D35-信息架构-底栏与清单长度.md](../../docs/decisions/D35-信息架构-底栏与清单长度.md)。

更多页的**快照 / 导入历史 / 回收站**合成一个卡片、三个平级面板，
左右滑动切换（`SwipePanels.vue`），条数写在分段标题上。
这三个的长度都不由界面决定 —— 快照封顶 10 条，导入历史只增不减，
回收站要等 30 天才清；被裁掉多少是看不见的，所以「一共几条」必须在滑动框外面。
页面高度实测 1637px → **847px（1.1 屏）**。理由与取舍见
[D35-信息架构-底栏与清单长度.md](../../docs/decisions/D35-信息架构-底栏与清单长度.md)。

二级页（单词页/意思页/错题板）从某处钻进去，返回时主 tab 高亮不变。
**单挑入口只有错题板一处**：在意思页点「练这个意思」等于送分。

顶栏那个返回箭头 **等价于系统返回键**（`src/nav.ts` 的 `goBack`），
另外兜两种情况：书签进来的深链没有上一层、合并/删除义项后上一格历史就是自己。
两页各写各的会让「意思页 push 回单词页」和「单词页 back 回意思页」围成环，
真机表现是按两次返回 URL 原封不动。

宽屏（≥900px）意思页是**两栏**：左边列出这个词的其它意思，点一下切过去，
省掉「回单词页 → 再点进去」这一跳。设计稿 §8.6 想要的是全站两栏，
现在只做了这一屏 —— 意思页是唯一值得这么做的地方。

## 交互保护：三件「不做会出事」的事

| 事 | 做法 | 为什么 |
|---|---|---|
| **例句编辑** | 点「改」才进编辑态，「改好了」退出；编辑中整行（含译文和按钮）留在键盘上方 | 例句点一下就改，手滑会改坏核心内容且当天无感 |
| **删除/覆盖** | 全部走 `ConfirmSheet` 底部弹层，**全站没有原生 `confirm()/prompt()`** | 原生对话框顶着 `The page at https://…` 一行、按钮是 CANCEL/OK，和这个 app 不像一家人 |
| **读库期间** | 骨架屏兜底；**首帧从常驻内存的表里同步读**（`db.ts` 的 `cachedNow`），启动时 `warmTables()` 预热 | mount→第一帧→await 读库→第二帧，**第一帧不管渲染什么都是跳变**（screencast 抓到过只剩一张灰条卡片那一帧） |
| **加载中不许对用户的数据下结论** | 首页分三态：`undefined`=还在读（骨架）、`null`=读完确实为空（「词库还是空的」）。同步版与异步版共用 `pickCard`/`computeStats` | 只有一个 `null` 时，第一帧会**说用户的词库没了** —— 假话会引发动作（去导入），比闪一下严重 |
| **轻提示** | `z-index: 9999` 压过 Vant 弹层；配色用 `--wb-card` + 细边 + 软阴影；「复制给 AI」成功即收弹层（失败留着） | Vant 层号从 2001 起**递增**，写死 2000 会被盖住且不报错（坑 44） |

另外：键盘避让只挪**被挡住的那一点**并夹在合法滚动区间内（见 `src/keyboard.ts`）；
拖动把手撑满整行并垂直居中（例句行两三行高，原来那个小热区按不准）；
次要信息（例句条数）没算出来之前**不写「0 句」**，宁可晚到也不要假数。
这几条都挂了断言，见 `scripts/verify_docs.py` 的「真机交互守卫」。

**怎么验「还闪不闪」**：守卫只能判代码写没写对，判不了屏幕上有没有闪。
后者用 CDP `Page.startScreencast` 逐帧录下来切页那几帧 ——
中间帧的字节数明显小于稳定帧（实测闪的那帧 9 KB vs 稳定 29 KB）就是闪了。

## 备份文件

导出走原生分享面板（`WBNative.shareFile`），文件名 **`词库备份_2026-10-18.json`**。
用 `.json` 而不是自定义后缀：系统不认识的后缀在「文件」App 里既不归类、也点不开，
导入时根本选不回来。

导入依赖壳里的 `WebChromeClient.onShowFileChooser` —— **没有它，
`<input type=file>.click()` 在 WebView 里什么都不发生**，两个导入入口全是这么哑掉的
（症状：点了毫无反应，网页侧无任何报错）。
另外 Chromium 要求用户激活才响应文件选择请求，**用 CDP 派发 `element.click()`
验不出来**，必须真触摸（`android.mjs tapxy`）。

## 数据模型：义项是一等实体

```
words     一个词：ipa / hidden
senses    义项：id(内部 UUID) / slot(显示编号 s1 s2 …) / gloss / glossEn / note
          pos / trap / tier / needsRefine / deletedAt(软删除)
sentences 例句：en / zh / spanStart+spanLen+form（高亮目标词）/ flagged / flagNote
progress  熟练度：挂 sense.id
reviewLog 作答流水：只增不改，主键 (sessionId, idx) 幂等
importLog 导入历史
snapshots 导入前的自动快照（只含内容层，保留 10 次）
```

**唯一关键设计：`Sense.id` 与 `Sense.slot` 分离。**

`slot` 只是显示编号，随便插、随便重排；`id` 是内部 UUID，永不变。
学习进度与例句都挂 `id`，所以插入/删除/重排/合并义项**都不会让熟练度错位**。
用 `s1` 当主键时「在 s1 前插入一个义项」会让后面全部漂移，
而用户完全感知不到（进度条还在，指向的意思变了）。

分层带来的三个能力：**回滚只回内容**（导入翻车不把背过的也退回去）、
**删义项进回收站**（连熟练度一起留，超 30 天自动清理，也可手动清空）、
**导出可选只导词库**。

## 导入协议

**一个入口，按 `format` 分派**（更多页 →「备份与导入 → 导入」），
或者直接从微信/QQ 里点开那个文件 —— 走同一条路。

| 格式 | 是什么 | 谁产出 | 会不会覆盖 |
|---|---|---|---|
| `word-bundle` v1 | content-kit 的内容包：多词、`build/bundle/cards.json`（1.4 MB，gitignore，一条命令重建） | `python content-kit/pipeline/build_bundle.py` | 不覆盖。释义不一致只报冲突，本地一个字不动 |
| `word.backup` v2 | 本应用导出的备份（含进度） | 应用内「导出」 | **覆盖**，先弹确认；导入前自动快照 |
| `word.import` v2 | AI 按「复制给 AI」模板回来的**单个词** | 豆包 / DeepSeek 等 | 逐条决策后才写 |

> 「发给 AI 的模板」只在**第三个**格式用：意思页/单词页点「复制给 AI」，
> 应用把「现有内容 + 要求 + 输出格式」拼好给你，内容包不经过 AI。

`word.import` v2：

```json
{ "format": "word.import", "schemaVersion": 2, "word": "crime",
  "senses": [{ "slot": 1, "pos": "n.", "gloss": "犯罪，罪行",
               "glossEn": "an act punishable by law", "note": "关键：受法律惩罚",
               "sentences": [{ "text": "...", "form": "crime", "clue": "...",
                               "translation": "..." }] }] }
```

`slot` 是**提示**而不是主键：写了就按位置对位，没写按 gloss 匹配。
外部不该关心内部 UUID，所以这个格式里没有 `senseId`。

`word.backup` v2 = `{ format, schemaVersion: 2, exportedAt, appVersion, stats,
words:[{word, ipa, hidden, senses:[{sense, sentences}]}], progress, reviews, imports }`。
恢复按 id 覆盖，流水按 `(sessionId, idx)` 幂等 —— 同一个文件导入两次不翻倍。

**认不出来的文件要说清它是什么、期望什么**，不给「跳过 N 处」这种
听起来像部分成功的话术（坑 48）。

## 导入为什么是「逐条决策」

`src/importer.ts` 先只读地算出差异（`planImport`），用户逐条选完才写库
（`applyPlan`）。默认动作：**释义保留本地**、例句追加缺的、新义项采纳、
本地独有义项保留。**没有「全部用导入的」** —— 批量覆盖就是丢数据的开始。
校验不过（word 不合法 / gloss 空 / 同词内英文释义重复 / 例句无原文）整份拒绝。

## 问题句闭环：背 → 发现问题 → 修内容

标记**长在句子行上**（`sentences.flagged` + `flagNote`），没有独立的 flag 表。
好处是「内容侧把这句删了」= 标记自动消失；代价是要小心另一种情况：
**只改译文、原文没变**时，导入替换例句会把标记弄丢，所以
`importer.applyPlan` / `backup.restoreBackup` 在整份替换前按英文原文存一份，
替换后搬回去（`flags.reapplyFlags`，测试守着这条）。

闭环跨两端，所以清单要能交出去：

```
错题板 →「有问题句」tab → 导出清单 → flags_20261017.json（word-flags v1）
    ↓
python content-kit/pipeline/triage_flags.py --from flags_20261017.json
    ↓  改 content-kit/data/sentences/<word>.tsv → sentence_audit → build_bundle
    ↓
应用里重新导入内容包（标记按原文保留），修好的在错题板点「已修好」关单
```

`word-flags` v1：`{format, schemaVersion:1, exportedAt, count, flags:[{word, slot, gloss, sentence, note}]}`。
带 `slot` 是因为内容侧的 TSV 按 `(word, senseId)` 组织，浏览器端没有全局 senseId。

## 移植一致性：SRS

`src/srs.ts` 是 `app/srs.mjs` 的逐函数移植，公式与参数一字不改
（参数由 `scripts/params2json.py` 从同一份 TSV 生成）。
这件事不能靠自觉，所以有测试：

```bash
node app/web/tests/srs_parity.mjs   # 400 条随机序列 × 12 步，两边逐格比对
node app/web/tests/flow_smoke.mjs    # 数据层端到端（fake-indexeddb）
node app/web/tests/scale_probe.mjs   # 可选：全库规模体检（需要 build/bundle/cards.json）
```

全库规模实测（`scale_probe`，Node + fake-indexeddb，浏览器只会更快）：

```
导入 2998 词 / 7884 义项 / 930 句      978 ms
全表读（三张表 toArray）                 93 ms
词库页聚合 2998 行                        1 ms
统计（更多页）                           105 ms
组一轮 20 张的队列                        70 ms
```

所以词库页必须**一次 bulkGet 拿全部进度**，不要在词循环里 await ——
那样是 3000 次串行查询，打开词库要等好几秒。

`flow_smoke` 覆盖：种子导入幂等、span 逐句对齐、增删改义项 id 不变、
合并并进度、导入对比的默认决策、出题 4 选项、作答流水幂等、标记退池、
**原文不变的替换后标记仍在**、清单能被内容侧 `triage_flags.py --from` 读懂、
备份回滚只回内容、回收站。

## 与旧服务端的关系

`app/server.mjs` 还在，但它**不再提供 UI**：现在它只负责托管交接区
（`build/bundle/`）、跑 `app/tools/` 下的进度与标记工具，并作为 SRS 的参照实现。
旧单页原型的存档格式 `progress.json`（CONTRACT.md §2）属于那条线；
本应用的备份格式是上面的 `word.backup` v2。两者不通用，不要混着导。