import io,json
src=r"D:\projectX\android\Word\app\config\srs_params.tsv"
dst=r"D:\projectX\android\Word\app\web\src\srs_params.json"
NUM=set("""S0_TRAP D0_TRAP S0_MULTI_S1 D0_MULTI_S1 S0_SINGLE D0_SINGLE S0_NEW D0_NEW
S0_RARE D0_RARE S_MAX S_MIN EF_A EF_B EF_MIN GRADE_FAST GRADE_SLOW GRADE_PEND GRADE_WRONG
FAST_BASE FAST_SLOPE SLOW_FACTOR S_PEND S_WRONG D_WRONG_BUMP D_DRIFT INTERVAL_FLOOR
DECAY_IDLE_FACTOR DECAY_IDLE SAME_DAY_HOURS SAME_DAY_FACTOR MASTER_S MASTER_REPS MASTER_STREAK""".split())
out={}
for line in io.open(src,encoding="utf-8"):
    line=line.rstrip("\n")
    if not line or line.startswith("#"): continue
    parts=line.split("\t")
    if len(parts)<2: continue
    k=parts[0].strip(); v=parts[1]
    out[k]=float(v) if k in NUM else v
missing=[k for k in NUM if k not in out]
assert not missing, "missing: %s"%missing
io.open(dst,"w",encoding="utf-8").write(json.dumps(out,ensure_ascii=False,indent=2)+"\n")
print("params ok:",len(out))
