"""Rank PyPI projects by downloads over the last complete calendar month, from ClickPy (public PyPI download data, CC BY 4.0).

Usage: pypi_rank.py <out.json> [top_n]
Writes {"source", "window", "generated", "rows": [{"project", "downloads"}]}.
"""
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request

URL = "https://sql-clickhouse.clickhouse.com/?" + urllib.parse.urlencode({"user": "demo", "default_format": "JSON"})
PAGE = 10_000  # the demo server caps max_result_rows at 10k


def query(sql):
    req = urllib.request.Request(URL, data=sql.encode(), method="POST",
                                 headers={"User-Agent": "gitcity-allowlist-build/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        page = json.loads(r.read())
    if page.get("exception"):
        raise SystemExit(page["exception"])
    return page["data"]


def main():
    out, top_n = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 15_000
    # pypi_downloads_per_day is incomplete on the demo server; the monthly table matches PyPI's totals
    month = (dt.date.today().replace(day=1) - dt.timedelta(days=1)).replace(day=1).isoformat()
    rows = []
    for offset in range(0, top_n, PAGE):
        rows += query(f"""
            SELECT project, sum(count) AS downloads
            FROM pypi.pypi_downloads_per_month
            WHERE month = '{month}'
            GROUP BY project
            ORDER BY downloads DESC, project
            LIMIT {min(PAGE, top_n - offset)} OFFSET {offset}""")
    for r in rows:
        r["downloads"] = int(r["downloads"])
    json.dump({"source": "ClickPy (sql-clickhouse.clickhouse.com, pypi.pypi_downloads_per_month); "
                         "data: PyPI download statistics, CC BY 4.0",
               "month": month, "generated": dt.date.today().isoformat(), "rows": rows},
              open(out, "w"), indent=0)
    print(f"{len(rows)} projects, month {month}, cut-off {rows[-1]['downloads']} downloads")


if __name__ == "__main__":
    main()
