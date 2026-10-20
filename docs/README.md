# 设计文档索引

> 内容产线与旧决策（D15–D31、design/01/02/04）已随 2026-10-20 整体删除，
> git 历史 `bfda5d7` 之前的任意提交可查。现行文档只有下面的清单。

## 施工文档

| 文档 | 作用 |
| --- | --- |
| [design/03-记忆曲线与复习.md](design/03-记忆曲线与复习.md) | SRS 行为规范：S/D 分离、TRAP 短间隔、90 天掌握门槛（已实现） |
| [design/05-数据模型-SQLite.md](design/05-数据模型-SQLite.md) | 旧进度库目标模型；落地为 4 表，SQL 在 `app/schema.sql`（已实现） |
| [DESIGN-词库系统v2.md](DESIGN-词库系统v2.md) | 应用搬到浏览器端的设计：Vue 3 + Dexie、义项 UUID 锚点（已实现） |
| [AI-操作手机闭环.md](AI-操作手机闭环.md) | AI 助手在手机上的操作闭环 |

## 决策记录（docs/decisions/）

现行决策 D32 起，一个决策一份文件：

- **D32** 应用搬到浏览器端（技术栈与义项 UUID 锚点）
- **D33** 交互保护优先 · **D34** 固定栏与橡皮筋 · **D35** 信息架构
- **D36** 训练是一个动作 · **D37** 答完之后才许查词
- **D38** 接 AI（可选增强）· **D39** 训练页也能换句 · **D40** 整库体检
- **D41** 词库按学习进度组织 · **D42** 加词一步到能背 · **D43** 训练页返回栈
- **D44** 首页随手背一句 · **D46** 练习是浮层 · **D47** 练习是首页的副页
- **D50** 首页两屏定稿 · **D51** 冗余判定标准 · **D52** 拼写加练 · **D53** 更名与图标

## 笔记（docs/notes/）

- [踩坑记录.md](notes/踩坑记录.md) — 真机踩坑与判据（可机械判定的部分挂在 `scripts/verify_docs.py` 的守卫里）
- [README.md](notes/README.md) — 笔记目录说明

## 验证

文档关键数字与源码形状全部可机械核对，从仓库根跑：

```bash
python scripts/verify_docs.py        # 结构守卫（D16 + 真机交互守卫 + 计数）
node app/tests/e2e_loop.mjs          # SRS / 事务 / 幂等 / 持久化
node app/web/tests/flow_smoke.mjs    # 数据层端到端
node app/web/tests/srs_parity.mjs    # SRS 移植一致性
python app/tests/verify_srs.py       # SRS 参数基准
```
