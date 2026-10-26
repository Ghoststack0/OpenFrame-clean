"""Paired summary of media-serving.mjs output. Labels must be baseline-<n> and candidate-<n>.

python3 analyze-media-serving.py results.jsonl
"""
import json,sys,statistics as st,math
rows=[json.loads(l) for l in open(sys.argv[1])]
by={}
for r in rows:
    v,i=r['label'].rsplit('-',1); by.setdefault((r['scenario'],v),{})[int(i)]=r
scen=sorted({s for s,_ in by})
def med(xs): return st.median(xs)
print(f"{'scenario':30} {'metric':10} {'base med':>9} {'cand med':>9} {'paired gm':>9} {'cand worse':>10}")
for s in scen:
    b=by.get((s,'baseline'),{}); c=by.get((s,'candidate'),{})
    keys=sorted(set(b)&set(c))
    for m,higher in [('wallMs',False),('rps',True),('p50',False),('p95',False),('ttfbP50',False),('ttfbP95',False),('serverCpuTicks',False)]:
        if m not in b[keys[0]]: continue
        bv=[b[k][m] for k in keys]; cv=[c[k][m] for k in keys]
        ratios=[(cv[j]/bv[j]) if higher else (bv[j]/cv[j]) for j in range(len(keys)) if bv[j] and cv[j]]
        gm=math.exp(sum(map(math.log,ratios))/len(ratios)) if ratios else float('nan')
        worse=sum(1 for x in ratios if x<1)
        print(f"{s:30} {m:10} {med(bv):9.2f} {med(cv):9.2f} {gm:8.3f}x {worse:>5}/{len(ratios)}")
