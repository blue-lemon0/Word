# -*- coding: utf-8 -*-
"""HTTP 冒烟：真起服务、走完一整场，验证「能体验 + 进度落盘 + 重放被折叠」。
用 curl 发 UTF-8 请求体（PowerShell 5.1 的 Invoke-RestMethod 会把中文搞坏）。
"""
import json, os, subprocess, sys, time, urllib.request

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.environ["TEMP"]
DB = os.path.join(PROJ, "data", "user.db")
PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"

fails = []


def ok(cond, name, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def post(path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=body,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.loads(r.read().decode("utf-8"))


if os.path.exists(DB):
    os.remove(DB)
    for ext in ("-wal", "-shm"):
        if os.path.exists(DB + ext):
            os.remove(DB + ext)

env = dict(os.environ, PORT=str(PORT))
proc = subprocess.Popen([ "node", "app/server.mjs"], cwd=PROJ, env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        try:
            get("/api/bootstrap")
            break
        except Exception:
            time.sleep(0.2)
    else:
        raise SystemExit("服务没起来")

    print("=== 首页 ===")
    b = get("/api/bootstrap")
    ok(b["cards"] == 7884, f'词库 {b["cards"]} 义项')
    ok(b["overview"]["pool"] > 0, f'可练 {b["overview"]["pool"]}（有句义项）')
    ok(b["overview"]["due"] == b["overview"]["pool"], '首次进入全部到期')

    print("\n=== 一整场 ===")
    _, st = post("/api/start", {})
    sid = st["sessionId"]
    total = st["total"]
    ok(total == b["overview"]["pool"], f'本场 {total} 题 = 到期卡数')
    answered = []
    while True:
        _, q = post("/api/next", {"sessionId": sid})
        if q.get("done"):
            break
        gloss = q["sentence"]["gloss"]
        picked = gloss if len(answered) % 2 == 0 else "__PENDING__"
        stc, a = post("/api/answer", {
            "sessionId": sid, "attemptId": q["attemptId"], "word": q["word"],
            "senseId": q["senseId"], "picked": picked, "elapsedMs": 2200,
        })
        if stc != 200:
            ok(False, "作答提交", str(a))
            break
        expect = "CORRECT" if picked == gloss else "PENDING"
        ok(a["result"] == expect and a["applied"],
           f'{q["word"]}#{q["senseId"]} {picked[:6]} → {a["result"]}',
           f'S={a["stability"]:.2f} D={a["difficulty"]:.1f} 下次={a["intervalDays"]:.2f}天')
        answered.append(q)

    print("\n=== 幂等：重放最后一道题 ===")
    last = answered[-1]
    _, q = post("/api/next", {"sessionId": sid})
    ok(q.get("done") is True, "队列已走完")
    # 手工重放：用最后一道题的 attemptId 再交一次（此时 s.attempt 已是 null → 409）
    stc, a = post("/api/answer", {
        "sessionId": sid, "attemptId": last["attemptId"], "word": last["word"],
        "senseId": last["senseId"], "picked": last["sentence"]["gloss"], "elapsedMs": 2200,
    })
    ok(stc == 409, f'过期 attempt 被拒（HTTP {stc}）')
    ov = get("/api/overview")
    ok(ov["answered"] == total, f'流水 {ov["answered"]} 行 = 作答 {total} 次（重放没被记两遍）')
    ok(ov["accuracy"] and ov["accuracy"][0]["n"] == total,
       f'正确率样本 n={ov["accuracy"][0]["n"]} pct={ov["accuracy"][0]["pct"]}')
    print(f'  小结: 对 {ov["accuracy"][0]["right_n"]} / {total}')

    print("\n=== 进度真的落盘了 ===")
    ok(os.path.exists(DB), f'{DB} 存在（{os.path.getsize(DB)} 字节）')
    proc.terminate()
    proc.wait(timeout=10)
    proc = subprocess.Popen(["node", "app/server.mjs"], cwd=PROJ, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            get("/api/bootstrap")
            break
        except Exception:
            time.sleep(0.2)
    ov2 = get("/api/overview")
    ok(ov2["answered"] == total, f'重启服务后流水仍是 {ov2["answered"]} 行')
    ok(ov2["due"] < total, f'练过的卡不再全部到期（due {b["overview"]["due"]} → {ov2["due"]}）')
    _, st2 = post("/api/start", {})
    ok(st2["total"] == ov2["due"], f'第二场题数 {st2["total"]} = 剩余到期数')
finally:
    proc.terminate()

print(f"\n结果: {'全部通过' if not fails else str(len(fails)) + ' 项失败: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)