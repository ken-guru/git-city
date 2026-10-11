"""Map PyPI project names to import names.

Chain per project (latest release):
  1. PEP 794 `Import-Name` from the wheel's core metadata (PEP 658 `.metadata` file, no wheel download)
  2. top-level names from the wheel's file list (zip central directory read with HTTP range requests)
  3. normalised project name

Usage: pypi_import_names.py <projects.txt> <out.jsonl> [workers]
Each output line: {"project", "import_names", "step", "error"?}
"""
import concurrent.futures as cf
import email.parser
import gzip
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.request

UA = {"User-Agent": "gitcity-allowlist-check/0.1 (+https://github.com/ken-guru/git-city)"}
stats = {"requests": 0, "bytes": 0}


def get(url, rng=None, method="GET"):
    h = dict(UA, **{"Accept-Encoding": "gzip"})
    if rng:
        h["Range"] = rng
    req = urllib.request.Request(url, headers=h, method=method)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                stats["requests"] += 1
                stats["bytes"] += len(body)
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return r, body
        except urllib.error.HTTPError as e:
            if e.code == 416 and rng and rng.startswith("bytes=-"):
                return get(url)  # file smaller than the tail window: fetch it whole
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise


def normalise(name):
    return re.sub(r"[-_.]+", "_", name).lower()


def pick_wheel(urls):
    wheels = [u for u in urls if u["packagetype"] == "bdist_wheel" and not u.get("yanked")]
    if not wheels:
        return None
    # prefer pure-python, then anything (top-level names don't vary by platform in practice)
    wheels.sort(key=lambda u: ("none-any" not in u["filename"], u["filename"]))
    return wheels[0]


def import_names_from_metadata(text):
    msg = email.parser.Parser().parsestr(text, headersonly=True)
    names = []
    for v in msg.get_all("Import-Name") or []:
        v = v.split(";")[0].strip()  # "name; private"
        if v:
            names.append(v.split(".")[0])
    return sorted(set(names))


def zip_names(url):
    """List file names in a remote zip by reading only its central directory."""
    tail_len = 65536
    r, tail = get(url, rng=f"bytes=-{tail_len}")
    total = int(r.headers["Content-Range"].rsplit("/", 1)[1]) if r.status == 206 else len(tail)
    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("no EOCD")
    cd_size, cd_off = struct.unpack("<II", tail[eocd + 12:eocd + 20])
    if cd_off == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:
        loc = tail.rfind(b"PK\x06\x07", 0, eocd)
        z64_off = struct.unpack("<Q", tail[loc + 8:loc + 16])[0]
        tail_start = total - len(tail)
        rec = tail[z64_off - tail_start:] if z64_off >= tail_start else get(url, rng=f"bytes={z64_off}-{z64_off + 55}")[1]
        cd_size, cd_off = struct.unpack("<QQ", rec[40:56])
    tail_start = total - len(tail)
    if cd_off >= tail_start:
        cd = tail[cd_off - tail_start:cd_off - tail_start + cd_size]
    else:
        cd = get(url, rng=f"bytes={cd_off}-{cd_off + cd_size - 1}")[1]
    names, i = [], 0
    while i + 46 <= len(cd) and cd[i:i + 4] == b"PK\x01\x02":
        n, m, k = struct.unpack("<HHH", cd[i + 28:i + 34])
        names.append(cd[i + 46:i + 46 + n].decode("utf-8", "replace"))
        i += 46 + n + m + k
    return names


MOD = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(\.[^/]*)?\.(py|so|pyd)$")


def top_level_from_files(files):
    """Importable names; PEP 420 namespace dirs (no __init__.py) are descended to dotted names."""
    files = [f for f in files if not f.split("/", 1)[0].endswith((".dist-info", ".data"))]
    fileset = set(files)

    def names_under(prefix, depth):
        out, dirs = set(), set()
        for f in files:
            if not f.startswith(prefix):
                continue
            rest = f[len(prefix):]
            head = rest.split("/", 1)[0]
            if "/" in rest:
                if head.isidentifier() and head != "__pycache__":
                    dirs.add(head)
            else:
                m = MOD.match(head)
                if m and m.group(1) != "__init__":
                    out.add(prefix.replace("/", ".") + m.group(1))
        for head in dirs:  # recurse once per directory, not once per file
            if f"{prefix}{head}/__init__.py" in fileset or depth >= 3:
                out.add(prefix.replace("/", ".") + head)
            else:
                out |= names_under(f"{prefix}{head}/", depth + 1)
        return out

    return sorted(names_under("", 0))


def resolve(project):
    out = {"project": project}
    try:
        _, body = get(f"https://pypi.org/pypi/{project}/json")
        data = json.loads(body)
        wheel = pick_wheel(data.get("urls", []))
        if wheel is None:
            out.update(import_names=[normalise(project)], step="normalised", note="no wheel")
            return out
        if wheel.get("core_metadata") or wheel.get("data-dist-info-metadata"):
            _, meta = get(wheel["url"] + ".metadata")
            names = import_names_from_metadata(meta.decode("utf-8", "replace"))
            if names:
                out.update(import_names=names, step="import-name")
                return out
        tops = top_level_from_files(zip_names(wheel["url"]))
        if tops:
            out.update(import_names=tops, step="wheel-files")
            return out
        out.update(import_names=[normalise(project)], step="normalised", note="empty wheel")
    except Exception as e:  # keep going; record the failure
        out.update(import_names=[normalise(project)], step="normalised", error=f"{type(e).__name__}: {e}")
    return out


def main():
    projects = [l.strip() for l in open(sys.argv[1]) if l.strip()]
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    t0 = time.time()
    with open(sys.argv[2], "w") as f, cf.ThreadPoolExecutor(workers) as ex:
        for i, res in enumerate(ex.map(resolve, projects), 1):
            f.write(json.dumps(res) + "\n")
            f.flush()
            if i % 500 == 0:
                print(f"{i}/{len(projects)} {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    print(json.dumps({"projects": len(projects), "seconds": round(time.time() - t0, 1), **stats}))


if __name__ == "__main__":
    main()
