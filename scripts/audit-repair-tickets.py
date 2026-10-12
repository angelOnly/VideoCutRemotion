"""只读汇总 Repair Ticket；不改变正式 Project、Job 或工单。"""
import sqlite3
import sys
import re
from collections import Counter

if len(sys.argv) not in (2, 3):
    raise SystemExit("用法：python scripts/audit-repair-tickets.py <app.sqlite> [工具名]")
database = sqlite3.connect(f"file:{sys.argv[1].replace(chr(92), '/')}?mode=ro", uri=True)
for title, query in (
    ("状态", "SELECT status, count(*) FROM repair_tickets GROUP BY status ORDER BY 2 DESC"),
    ("Open 的 Job 状态", "SELECT coalesce(j.status, '无关联 Job'), count(*) FROM repair_tickets t LEFT JOIN jobs j ON j.id=t.job_id WHERE t.status='open' GROUP BY 1 ORDER BY 2 DESC"),
    ("Open 的工具及类别", "SELECT coalesce(tool_name, '无工具'), category, count(*) FROM repair_tickets WHERE status='open' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40"),
    ("Open 重复摘要", "SELECT substr(summary,1,100), count(*) FROM repair_tickets WHERE status='open' GROUP BY summary HAVING count(*)>1 ORDER BY 2 DESC LIMIT 40"),
):
    print(f"\n{title}")
    for row in database.execute(query):
        print(ascii(row))
codes = Counter()
for summary, detail, error in database.execute("""SELECT t.summary,coalesce(t.detail,''),coalesce(j.error,'')
    FROM repair_tickets t LEFT JOIN jobs j ON j.id=t.job_id WHERE t.status='open'"""):
    match = re.search(r"\b(?:MOTION|MCP|ASSET|RENDER|PREVIEW|JOB)_[A-Z0-9_]+\b", " ".join((error, summary, detail)))
    codes[match.group(0) if match else "未记录结构化错误码"] += 1
print("\nOpen 的错误码（每单取首个）")
for row in codes.most_common(30):
    print(ascii(row))
if len(sys.argv) == 3:
    print("\n指定工具的 Open 工单")
    for row in database.execute("""SELECT t.id,t.category,t.summary,substr(coalesce(t.detail,''),1,300),coalesce(j.status,'无关联 Job'),coalesce(j.error,'')
        FROM repair_tickets t LEFT JOIN jobs j ON j.id=t.job_id
        WHERE t.status='open' AND t.tool_name=? ORDER BY t.created_at""", (sys.argv[2],)):
        print(ascii(row))
