"""Word → PDF for the TRADECOM orders board.
The board queues a job (collection "pdfjobs"); this script, run by GitHub Actions, converts the Word file
with LibreOffice and puts the PDF next to it in the same order.
Needs the secret SUPABASE_SERVICE_KEY (Supabase → Project Settings → API keys → secret key)."""
import base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request, uuid

URL = os.environ.get("SUPABASE_URL", "https://jbdqkjplajdlczdexkxd.supabase.co").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
BUCKET = "files"
MODE = sys.argv[1] if len(sys.argv) > 1 else "run"


def headers(extra=None):
    h = {"apikey": KEY}
    if not KEY.startswith("sb_"):          # a legacy service_role key is a JWT and also goes as a bearer token
        h["Authorization"] = "Bearer " + KEY
    h.update(extra or {})
    return h


def call(method, path, body=None, ctype="application/json", raw=False):
    data = None
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, method=method, headers=headers({"Content-Type": ctype} if data is not None else None))
    with urllib.request.urlopen(req, timeout=120) as r:
        out = r.read()
    return out if raw else (json.loads(out) if out else None)


def jobs():
    rows = call("GET", "/rest/v1/docs?coll=eq.pdfjobs&select=id,data")
    return [r for r in rows if (r.get("data") or {}).get("status") == "queued"]


def merge(coll, id_, patch):
    call("POST", "/rest/v1/rpc/doc_merge", {"c": coll, "i": id_, "patch": patch})


def order(oid):
    rows = call("GET", "/rest/v1/docs?coll=eq.orders&id=eq." + urllib.parse.quote(oid) + "&select=data")
    return rows[0]["data"] if rows else None


def missing_fonts(blob):
    """Latin/Cyrillic fonts the document uses that are not installed (Korean fonts fall back to Noto CJK)."""
    import io, re, zipfile
    z = zipfile.ZipFile(io.BytesIO(blob))
    # fonts on the text itself (body, headers, footers), not every font a style sheet happens to list
    xml = "".join(z.read(n).decode("utf8", "ignore") for n in z.namelist() if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n))
    used = set(re.findall(r'w:(?:ascii|hAnsi)="([^"]+)"', xml)) - {"", "Symbol", "Wingdings"}
    have = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True).stdout.lower()
    have = {x.strip() for line in have.splitlines() for x in line.split(",")}
    return sorted(f for f in used if not f.startswith("+") and f.lower() not in have)


def convert(job_id, job):
    o = order(job["oid"])
    if not o:
        raise RuntimeError("заказ не найден")
    f = next((x for x in o.get("files", []) if x.get("aid") == job["aid"]), None)
    if not f:
        raise RuntimeError("файл уже удалён из заказа")
    blob = call("GET", f"/storage/v1/object/{BUCKET}/{f['aid']}", raw=True)
    if f.get("enc") == "b64":
        blob = base64.b64decode(blob.decode().strip())
    missing = missing_fonts(blob)
    if missing:  # no font substitution: without the original font the PDF is not made
        raise RuntimeError("нет шрифта: " + ", ".join(missing) + " — загрузите его файлы в Supabase → Storage → files → _fonts")
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.docx")
        open(src, "wb").write(blob)
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", d, src], check=True, timeout=300,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pdf = open(os.path.join(d, "in.pdf"), "rb").read()
    new_id = uuid.uuid4().hex
    call("POST", f"/storage/v1/object/{BUCKET}/{new_id}", pdf, ctype="application/pdf")
    name = f["name"][:-5] + ".pdf" if f["name"].lower().endswith(".docx") else f["name"] + ".pdf"
    rec = {"aid": new_id, "name": name, "kind": f.get("kind", "other"), "from": f["aid"], "by": job.get("by", ""),
           "size": len(pdf), "mime": "application/pdf", "enc": "raw", "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "viaPdf": True}
    if f.get("signer"):
        rec["signer"] = f["signer"]
    o = order(job["oid"])  # read again right before writing, so nothing added meanwhile is lost
    merge("orders", job["oid"], {"files": (o.get("files") or []) + [rec], "updatedAt": rec["at"]})
    merge("pdfjobs", job_id, {"status": "done", "pdf": new_id, "doneAt": rec["at"]})
    print("готово:", name)


def fonts():
    """The contract fonts (Arial Narrow, 맑은 고딕 …) are not free to publish, so they live in the private storage
    folder «_fonts/» and are installed here before converting; LibreOffice then lays the text out in the original font."""
    try:
        items = call("POST", f"/storage/v1/object/list/{BUCKET}", {"prefix": "_fonts/", "limit": 1000})
    except Exception as e:
        print("папка _fonts недоступна:", e)
        return 0
    d = os.path.expanduser("~/.fonts")
    os.makedirs(d, exist_ok=True)
    n = 0
    for it in items or []:
        name = it.get("name") or ""
        if not name.lower().endswith((".ttf", ".otf", ".ttc")):
            continue
        open(os.path.join(d, name), "wb").write(call("GET", f"/storage/v1/object/{BUCKET}/_fonts/{urllib.parse.quote(name)}", raw=True))
        n += 1
    subprocess.run(["fc-cache", "-f"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("шрифтов установлено:", n)
    return n


def main():
    if not KEY:
        sys.exit("SUPABASE_SERVICE_KEY не задан в секретах репозитория")
    q = jobs()
    if MODE == "check":                      # tells the workflow whether LibreOffice needs installing at all
        open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a").write(f"jobs={len(q)}\n")
        print("в очереди:", len(q))
        return
    if q:
        fonts()
    for r in q:
        try:
            merge("pdfjobs", r["id"], {"status": "working"})
            convert(r["id"], r["data"])
        except Exception as e:  # the board shows the reason next to the file
            msg = e.read().decode()[:200] if isinstance(e, urllib.error.HTTPError) else str(e)[:200]
            print("ошибка:", r["id"], msg)
            merge("pdfjobs", r["id"], {"status": "error", "error": msg})


main()
