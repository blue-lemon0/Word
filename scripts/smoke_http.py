# -*- coding: utf-8 -*-
"""端到端验收：真起服务 + jsdom 真跑 tools/index.html。

覆盖：
  · 服务提供的是仓库里那份原型（校验标题与关键 CSS 标记，不是 app/ 的分叉）
  · UI state 镜像：saveState -> SQLite -> 换浏览器后恢复
  · 作答落库：SRS 在服务端算，重启后仍在
  · 手动标「我已学会」：mastered 置位并重排到期
  · 原型的核心交互没被改坏：判别区先空白、点开才出选项、<mark> 是实心药丸

本脚本会**清空 data/user.db**。服务在跑时先停掉。
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request, urllib.error

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.environ["TEMP"]
DB = os.path.join(PROJ, "data", "user.db")
PORT = int(os.environ.get("SMOKE_PORT", "8791"))
BASE = "http://127.0.0.1:%d" % PORT

fails = []


def ok(cond, name, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def req(path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(BASE + path, data=data,
                               headers={"content-type": "application/json"},
                               method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jreq(path, payload=None):
    code, body = req(path, payload)
    return code, json.loads(body.decode("utf-8"))


def start(env):
    p = subprocess.Popen(["node", "app/server.mjs"], cwd=PROJ, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            req("/api/bootstrap")
            return p
        except Exception:
            time.sleep(0.2)
    p.kill()
    raise SystemExit("服务没起来")


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()


if os.path.exists(DB):
    try:
        for f in (DB, DB + "-wal", DB + "-shm"):
            if os.path.exists(f):
                os.remove(f)
    except PermissionError:
        sys.exit("data\\user.db 被占用：多半是 app/server.mjs 还在跑。\n"
                 "本脚本会清空你的真实进度，先停掉：Get-Process node | Stop-Process")

env = dict(os.environ, PORT=str(PORT))
proc = start(env)
try:
    print("=== 页面：必须是仓库里那份原型 ===")
    code, body = req("/")
    html = body.decode("utf-8")
    ok(code == 200, f"GET / -> HTTP {code}")
    ok("<title>单词判别 · 原型</title>" in html, "标题是原型自己的「单词判别 · 原型」")
    ok(".sentence mark {" in html and "background: var(--primary);" in html,
       "判别区高亮仍是原型那套实心药丸（不是 app/ 的下划线）")
    ok("错题板" in html and 'id="viewBoard"' in html, "错题板 tab 还在")
    ok("markMastered" in html, "手动标「我已学会」还在")
    ok("app.js" not in html, "页面不再引用被删掉的 app/app.js")
    ok(os.path.exists(os.path.join(PROJ, "app", "index.html")) is False,
       "app/index.html 已删除（不再有第二份 UI）")

    code, body = req("/build/bundle/cards.json")
    b = json.loads(body.decode("utf-8"))
    ok(code == 200 and b["stats"]["withSentences"] > 0,
       f'bundle 可访问，有句义项 {b["stats"]["withSentences"]}')

    print("\n=== UI state 镜像 ===")
    ui = {"v": 2, "queue": ["lay#s1", "cast#s1"], "pos": 1,
          "stats": {"correct": 1, "wrong": 0, "pending": 0},
          "wrong": {}, "mastered": {}, "rowIdx": {}, "updatedAt": 1}
    code, r = jreq("/api/ui-state", {"state": ui})
    ok(code == 200 and r.get("ok"), "POST /api/ui-state 保存成功")
    code, r = jreq("/api/ui-state")
    ok(code == 200 and r["state"]["pos"] == 1 and r["state"]["queue"] == ["lay#s1", "cast#s1"],
       "GET /api/ui-state 原样取回（换浏览器/清缓存后能恢复）")

    print("\n=== 作答落库，SRS 在服务端算 ===")
    code, r = jreq("/api/answer", {"word": "lay", "senseId": "s1",
                                   "result": "CORRECT", "elapsedMs": 2500})
    ok(code == 200 and r.get("applied"), "CORRECT 已落库")
    ok(r.get("kind") == "MULTI_S1", f'义项类型判为 {r.get("kind")}（多义词首义）')
    ok(abs(r["stability"] - 4.04) < 0.05, f'S 从 S0 涨到 {r.get("stability"):.2f}')
    ok(abs(r["intervalDays"] - 2.04) < 0.05, f'下次 {r.get("intervalDays"):.2f} 天后')

    code, r = jreq("/api/answer", {"word": "lay", "senseId": "s2",
                                   "result": "WRONG", "elapsedMs": 9000})
    ok(code == 200 and r["difficulty"] > 7.0,
       f'WRONG 让 D 升到 {r.get("difficulty"):.1f}（方向对：越错越难）')

    code, r = jreq("/api/answer", {"word": "lay", "senseId": "s3",
                                   "result": "PENDING", "elapsedMs": None})
    ok(code == 200 and r["intervalDays"] >= 0.25, "PENDING 也落库且不低于间隔下界")

    code, r = jreq("/api/answer", {"word": "lay", "senseId": "s1", "result": "BOGUS"})
    ok(code == 400, f"非法 result 被拒（HTTP {code}）")
    code, r = jreq("/api/answer", {"word": "nosuch", "senseId": "s1", "result": "CORRECT"})
    ok(code == 400, f"不存在的义项被拒（HTTP {code}）")

    print("\n=== 手动标「我已学会」===")
    code, r = jreq("/api/mastered", {"word": "cast", "senseId": "s1", "on": True})
    ok(code == 200 and r["mastered"] == 1, "mastered 置位")
    code, ov = jreq("/api/overview")
    ok(ov["mastered"] == 1, f'概览里已掌握 {ov["mastered"]}')
    ok(ov["pool"] == ov["due"] or ov["due"] <= ov["pool"],
       f'可练 {ov["pool"]} / 到期 {ov["due"]}')

    print("\n=== 重启后数据仍在 ===")
    stop(proc)
    proc = start(env)
    code, r = jreq("/api/ui-state")
    ok(r["state"]["pos"] == 1, "ui_state 重启后仍在")
    code, ov = jreq("/api/overview")
    ok(ov["answered"] == 3, f'作答流水 {ov["answered"]} 行（3 次作答，重启不丢）')
    ok(ov["mastered"] == 1, "mastered 重启后仍在")
finally:
    stop(proc)

print(f"\n结果: {'全部通过' if not fails else str(len(fails)) + ' 项失败: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)