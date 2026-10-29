#!/usr/bin/env python3
"""Local server for the travel map. Viewing is open. Saving needs the author pin."""

import json
import secrets
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLACES = ROOT / "data" / "places.json"
JS = ROOT / "places.js"
PIN_PATH = ROOT / ".author-pin"
UA = "ya-tam-byl-map/1.0 (personal travel map)"
HOST = "0.0.0.0"
PORT = 8765

_lock = threading.Lock()
_last_geo = 0.0

BLOCK_PARTS = {
    ".author-pin",
    "serve.py",
    "posts.json",
    "seed_places.json",
}


def pin():
    if PIN_PATH.exists():
        return PIN_PATH.read_text(encoding="utf-8").strip()
    value = f"{secrets.randbelow(900000) + 100000}"
    PIN_PATH.write_text(value + "\n", encoding="utf-8")
    return value


def write_places(places):
    payload = json.dumps(places, ensure_ascii=False, indent=2)
    tmp = PLACES.with_suffix(".json.tmp")
    tmp.write_text(payload + "\n", encoding="utf-8")
    tmp.replace(PLACES)
    JS.write_text("window.PLACES = " + payload + ";\n", encoding="utf-8")


def nominatim(url):
    global _last_geo
    with _lock:
        wait = 1.05 - (time.time() - _last_geo)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as response:
            body = response.read()
        _last_geo = time.time()
        return body


def clean_place(raw):
    if not isinstance(raw, dict):
        raise ValueError("Некорректное место")
    name = str(raw.get("name") or "").strip()
    if not name or len(name) > 120:
        raise ValueError("Нужно название")
    try:
        lat = float(raw.get("lat"))
        lon = float(raw.get("lon"))
    except (TypeError, ValueError):
        raise ValueError("Нужна точка на карте")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Странные координаты")
    status = raw.get("status")
    if status not in ("been", "wish"):
        raise ValueError("Неизвестный статус")
    ident = str(raw.get("id") or "").strip()
    if not ident or len(ident) > 80 or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in ident):
        raise ValueError("Плохой идентификатор")
    tags = raw.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    tags = [str(tag).strip()[:40] for tag in tags if str(tag).strip()][:8]
    yandex = str(raw.get("yandex") or "").strip()
    if yandex and not (yandex.startswith("https://") or yandex.startswith("http://")):
        yandex = ""
    if not yandex:
        yandex = f"https://yandex.ru/maps/?pt={lon},{lat}&z=16&l=map"
    if status == "been":
        incoming = raw.get("visits")
        if not isinstance(incoming, list) or not incoming:
            incoming = [{
                "post": raw.get("post"),
                "summary": raw.get("summary"),
                "visited": raw.get("visited"),
                "verdict": raw.get("verdict") or "like",
            }]
        if len(incoming) > 20:
            raise ValueError("Слишком много постов")
        visits = [clean_visit(item) for item in incoming]
        verdicts = {item["verdict"] for item in visits}
        verdict = next(iter(verdicts)) if len(verdicts) == 1 else "mixed"
        latest = sorted(visits, key=lambda item: item.get("visited") or "", reverse=True)[0]
        post = latest.get("post")
        visited = latest.get("visited")
        summary = latest.get("summary") or ""
    else:
        visits = []
        verdict = None
        visited = None
        summary = str(raw.get("summary") or "").strip()[:500]
        post = str(raw.get("post") or "").strip()
        if post and not (post.startswith("https://") or post.startswith("http://")):
            post = ""
        post = post[:300] or None
    return {
        "id": ident,
        "name": name,
        "status": status,
        "verdict": verdict,
        "city": str(raw.get("city") or "").strip()[:60],
        "visited": visited,
        "post": post,
        "visits": visits,
        "address": str(raw.get("address") or "").strip()[:180],
        "tags": tags,
        "lat": lat,
        "lon": lon,
        "yandex": yandex[:400],
        "summary": summary,
    }


def clean_visit(raw):
    if not isinstance(raw, dict):
        raise ValueError("Некорректный пост")
    post = str(raw.get("post") or "").strip()
    if post and not (post.startswith("https://") or post.startswith("http://")):
        raise ValueError("Ссылка на пост должна начинаться с http")
    if len(post) > 300:
        raise ValueError("Слишком длинная ссылка")
    verdict = raw.get("verdict")
    if verdict not in ("like", "dislike", "mixed"):
        raise ValueError("У каждого поста нужен отзыв")
    summary = str(raw.get("summary") or "").strip()[:500]
    if not post and not summary:
        raise ValueError("У поста нужна ссылка или пара слов")
    visited = str(raw.get("visited") or "").strip()[:10] or None
    return {
        "post": post or None,
        "summary": summary,
        "visited": visited,
        "verdict": verdict,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _blocked(self):
        path = urllib.parse.urlparse(self.path).path
        parts = [part for part in path.split("/") if part]
        return any(part in BLOCK_PARTS or part.startswith(".") for part in parts)

    def do_GET(self):
        if self._blocked():
            self.send_error(404)
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(200, {"ok": True, "writable": True})
            return
        if parsed.path == "/api/geocode":
            self._geocode(parsed.query)
            return
        if parsed.path == "/api/reverse":
            self._reverse(parsed.query)
            return
        super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/places":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 100_000:
            self._json(413, {"error": "Слишком большой запрос"})
            return
        if self.headers.get("X-Pin", "").strip() != pin():
            self._json(401, {"error": "Неверный код автора"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "Не JSON"})
            return
        if body.get("action") == "ping":
            self._json(200, {"ok": True})
            return
        try:
            places = json.loads(PLACES.read_text(encoding="utf-8"))
            if body.get("action") == "delete":
                ident = str(body.get("id") or "")
                places = [place for place in places if place.get("id") != ident]
            else:
                place = clean_place(body.get("place"))
                places = [item for item in places if item.get("id") != place["id"]]
                places.append(place)
            write_places(places)
        except ValueError as error:
            self._json(400, {"error": str(error)})
            return
        except Exception:
            self._json(500, {"error": "Не удалось сохранить"})
            return
        self._json(200, {"ok": True, "count": len(places)})

    def _geocode(self, query):
        params = urllib.parse.parse_qs(query)
        text = (params.get("q") or [""])[0].strip()
        if len(text) < 2:
            self._json(200, [])
            return
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
            "q": text,
            "format": "jsonv2",
            "limit": "5",
            "accept-language": "ru",
        })
        self._proxy(url)

    def _reverse(self, query):
        params = urllib.parse.parse_qs(query)
        try:
            lat = float((params.get("lat") or [""])[0])
            lon = float((params.get("lon") or [""])[0])
        except ValueError:
            self._json(400, {"error": "Нет координат"})
            return
        url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode({
            "lat": lat,
            "lon": lon,
            "format": "jsonv2",
            "accept-language": "ru",
        })
        self._proxy(url)

    def _proxy(self, url):
        try:
            body = nominatim(url)
        except Exception:
            self._json(502, {"error": "Геокодер не ответил"})
            return
        data = json.loads(body.decode("utf-8"))
        self._json(200, data)

    def _json(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith("4"):
            super().log_message(fmt, *args)


def lan_ip():
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


if __name__ == "__main__":
    code = pin()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Карта: http://127.0.0.1:{PORT}", flush=True)
    print(f"Для других в этой сети: http://{lan_ip()}:{PORT}", flush=True)
    print(f"Код автора: {code}", flush=True)
    httpd.serve_forever()
