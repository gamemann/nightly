#!/usr/bin/env python3
"""Build a synthetic Nightly database and review store for screenshots: python3 scripts/seed-demo.py <dir>.
Everything is invented (fixed seed); nothing is read from a real panel. Run the panel on it with
NIGHTLY_DB=<dir>/nightly.db NIGHTLY_REVIEWS=<dir>/reviews."""
import glob, json, os, random, sqlite3, sys
from datetime import datetime, timedelta, timezone

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
dbp = os.path.join(out, 'nightly.db')
if os.path.exists(dbp): os.remove(dbp)
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
c = sqlite3.connect(dbp)
import subprocess
# The tables come from the schema itself, so the seed never drifts from the migrations.
c.executescript(subprocess.run(['npx', 'prisma', 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'], cwd=root, check=True, capture_output=True, text=True).stdout)
R = random.Random(7)
now = datetime.now(timezone.utc).replace(microsecond=0)
iso = lambda d: d.strftime('%Y-%m-%d %H:%M:%S')
ms = lambda d: int(d.timestamp() * 1000)
def ins(table, row):
    c.execute(f"insert into {table} ({','.join('"' + k + '"' for k in row)}) values ({','.join('?' * len(row))})", list(row.values()))
    return c.execute('select last_insert_rowid()').fetchone()[0]

def t(d): return ms(d)  # Prisma sqlite stores DateTime as epoch millis
scheds = [ins('Schedule', dict(name=n, cron=cr, enabled=1, prompt='nightly.md', instructions='', maxTurns=400, allowOverlap=0, createdAt=t(now - timedelta(days=60)), updatedAt=t(now)))
          for n, cr in [('Nightly sweep', '30 1 * * *'), ('Midday audit', '0 12 * * 1-5'), ('Weekend deep check', '0 3 * * 6'), ('Hourly QA', '15 */6 * * *')]]
chance = {0: 0.85, 1: 0.7, 2: 0.6, 3: 0.9}
for d in range(40, 0, -1):
    for i, sid in enumerate(scheds):
        if R.random() > (0.95 if i != 2 else 0.2): continue
        for h in ([1] if i == 0 else [12] if i == 1 else [3] if i == 2 else [3, 9, 15, 21]):
            st = (now - timedelta(days=d)).replace(hour=h, minute=R.choice([0, 15, 30]))
            roll = R.random(); ok = chance[i]
            status = 'ok' if roll < ok * 0.7 else 'findings' if roll < ok else 'failed' if roll < ok + (1 - ok) * 0.7 else 'skipped'
            mins = max(2, R.gauss(38 + 10 * i, 12)) if status != 'skipped' else None
            ins('Run', dict(startedAt=t(st), finishedAt=t(st + timedelta(minutes=mins or 0)), status=status, summary='Synthetic run', trigger='cron', scheduleId=sid,
                            minutes=mins, costUsd=round(mins * R.uniform(0.04, 0.09), 2) if mins else None, turns=R.randint(40, 300)))
ins('Run', dict(startedAt=t(now - timedelta(minutes=12)), status='running', summary='Synthetic run', trigger='manual', scheduleId=scheds[0]))
c.execute('update Schedule set lastFiredAt=? where id=?', (t(now - timedelta(hours=5)), scheds[0]))

for i, (st, kind) in enumerate([('queue', 'task')] * 9 + [('in_progress', 'task')] * 3 + [('review', 'task')] * 4 + [('blocked', 'task')] * 2 + [('queue', 'issue')] * 5 + [('done', 'task')] * 30):
    ins('Item', dict(key=f'demo-{i + 1}', title=f'Demo item {i + 1}', body='Synthetic.', kind=kind, status=st, priority=R.randint(0, 3), repos='demo-game', addedBy='owner',
                     createdAt=t(now - timedelta(days=R.randint(1, 30))), updatedAt=t(now)))

# QA
areas = [('arena', 'smoke'), ('arena', 'visual'), ('harbor', 'smoke'), ('harbor', 'perf'), ('canyon', 'smoke'), ('canyon', 'visual')]
for d in range(30, -1, -1):
    for g, k in areas:
        if R.random() > 0.8: continue
        total = R.randint(20, 40); bad = 0 if R.random() < 0.7 else R.randint(1, 6)
        ins('QaRun', dict(kind=k, game=g, commit='abc1234', ranAt=t(now - timedelta(days=d, hours=R.randint(0, 20))), ok=int(bad == 0), total=total, failedCount=bad,
                          createdAt=t(now)))

# Assets
packs = [('alpha-weapons', 'weapon', 40), ('alpha-props', 'prop', 30), ('beta-weapons', 'weapon', 25), ('beta-vehicles', 'vehicle', 12), ('gamma-props', 'prop', 18)]
codes = [('tex-oversize', 'warn', 'textures'), ('tris-high', 'error', 'models'), ('anim-missing', 'warn', 'animations'), ('snd-long', 'warn', 'sounds'), ('no-lod', 'warn', 'models')]
for pack, kind, n in packs:
    base = {'alpha': 78, 'beta': 55, 'gamma': 66}[pack.split('-')[0]]
    for i in range(n):
        score = max(5, min(100, int(R.gauss(base, 20)))); fl = []
        for cd, sv, _ in codes:
            if R.random() < (100 - score) / 160: fl.append(dict(code=cd, severity=sv))
        data = dict(flags=fl, model=dict(tris=R.randint(800, 60000), verts=R.randint(500, 40000), materials=R.randint(1, 6)), textures=[dict(w=1024, h=1024, bytes=R.randint(100000, 3000000), maps=['albedo'])] * R.randint(1, 4),
                    animations=[dict(length=R.random() * 3)] if R.random() < .5 else [], sounds=[], _files={})
        ins('AssetWeapon', {'pass': int(score >= 60 and not fl), **dict(pack=pack, game='demo', weaponId=f'{pack}-{i + 1:02d}', kind=kind, source='scan', score=score, auditedAt=iso(now), updatedAt=iso(now),
                                flagCount=len(fl), flagCodes=','.join(f['code'] for f in fl), data=json.dumps(data))})
c.commit(); c.close()

# Reviews
rv = os.path.join(out, 'reviews'); os.makedirs(rv, exist_ok=True)
c = sqlite3.connect(dbp)
for i, (title, n) in enumerate([('Weapon pass one', 14), ('Vehicle models', 9), ('Prop textures', 20), ('Sound sweep', 6)]):
    key = f'review-demo-{i + 1}'
    ins('Item', dict(key=key, title=title, body='Synthetic review.', kind='review', status='review', repos='demo-game', addedBy='owner', createdAt=t(now - timedelta(days=10 - i)), updatedAt=t(now)))
    ws = {}
    for w in range(n):
        v = R.choice(['good', 'good', 'wrong', ''] if i != 3 else ['']); at = now - timedelta(days=R.randint(0, 20))
        ws[f'w{w + 1}'] = dict(title=f'Item {w + 1}', media=[], verdict=v, note='', by='owner' if v else '', at=at.isoformat() if v else '', history=[dict(verdict=v, note='', by='owner', at=at.isoformat())] if v else [])
    os.makedirs(os.path.join(rv, key), exist_ok=True)
    json.dump(dict(weapons=ws), open(os.path.join(rv, key, 'review.json'), 'w'))
c.commit(); c.close()
print('seeded', dbp)
