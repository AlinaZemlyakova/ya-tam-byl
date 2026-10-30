#!/usr/bin/env python3
"""Pull new channel posts onto the map and keep a photo next to each note.

Existing places keep their coordinates and wording. A new post with a 📌
becomes a place, or another visit if that spot is already on the map.
"""

import json
import re
import time
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLACES = ROOT / "data" / "places.json"
JS = ROOT / "places.js"
IMAGES = ROOT / "images"
UA = "ya-tam-byl-map/1.0 (personal travel map)"
CHANNEL = "https://t.me/s/ya_tam_byl"

CITY_BY_TAG = {
    "мск": "Москва",
    "спб": "Санкт-Петербург",
    "карелия": "Карелия",
    "сочи": "Сочи",
}
_last_geo = 0.0


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def html_text(fragment):
    fragment = re.sub(r"(?i)<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    fragment = unescape(fragment)
    fragment = fragment.replace("\xa0", " ")
    return fragment.strip()


def scrape():
    messages = {}
    before = None
    seen = set()
    for _ in range(40):
        url = CHANNEL if not before else f"{CHANNEL}?before={before}"
        if url in seen:
            break
        seen.add(url)
        html = fetch(url).decode("utf-8", "replace")
        parts = html.split('tgme_widget_message_wrap')
        fresh = 0
        for part in parts[1:]:
            post = re.search(r'data-post="ya_tam_byl/(\d+)"', part)
            if not post:
                continue
            msgid = post.group(1)
            if msgid in messages:
                continue
            text_match = re.search(r'class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', part, re.S)
            text = html_text(text_match.group(1)) if text_match else ""
            photos = []
            for raw in re.findall(r"background-image:url\('([^']+)'\)", part):
                if "telegram.org/img/emoji" in raw:
                    continue
                if raw.startswith("//"):
                    raw = "https:" + raw
                if raw.startswith("https://"):
                    photos.append(raw)
            dated = re.search(r'<time[^>]*datetime="([^"]+)"', part)
            messages[msgid] = {
                "id": msgid,
                "text": text,
                "date": (dated.group(1)[:10] if dated else ""),
                "photo": photos[0] if photos else "",
            }
            fresh += 1
        older = re.search(r'href="/s/ya_tam_byl\?before=(\d+)"', html)
        if not older or older.group(1) == before or fresh == 0:
            break
        before = older.group(1)
        time.sleep(0.4)
    return messages


def post_id(url):
    match = re.search(r"/(\d+)$", url or "")
    return match.group(1) if match else ""


def coords_from_url(url):
    patterns = (
        (r"[?&]text=(-?\d+\.\d+),(-?\d+\.\d+)", False),
        (r"[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)", True),
        (r"[?&]pt=(-?\d+\.\d+),(-?\d+\.\d+)", True),
        (r"[?&]sll=(-?\d+\.\d+),(-?\d+\.\d+)", True),
    )
    for pattern, lon_first in patterns:
        match = re.search(pattern, url or "")
        if not match:
            continue
        a, b = float(match.group(1)), float(match.group(2))
        return (b, a) if lon_first else (a, b)
    return None


def geocode(query):
    global _last_geo
    wait = 1.1 - (time.time() - _last_geo)
    if wait > 0:
        time.sleep(wait)
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "format": "jsonv2",
        "limit": "1",
        "accept-language": "ru",
        "q": query,
    })
    try:
        body = fetch(url)
    except Exception as error:
        print(f"геокодер не ответил: {error}")
        _last_geo = time.time()
        return None
    _last_geo = time.time()
    rows = json.loads(body.decode("utf-8"))
    if not rows:
        return None
    return float(rows[0]["lat"]), float(rows[0]["lon"])


def pins(text):
    chunks = re.split(r"📌\s*", text)
    if len(chunks) < 2:
        return []
    found = []
    for chunk in chunks[1:]:
        lines = []
        for line in chunk.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("[?q="):
                continue
            lines.append(line)
        if not lines:
            continue
        name = lines[0].strip("«»\"")
        address = ""
        yandex = ""
        for line in lines[1:]:
            if "yandex.ru/maps" in line or line.startswith("http"):
                yandex = line.split()[0]
                break
            if not address:
                address = line
        if name:
            found.append({"name": name[:120], "address": address[:180], "yandex": yandex[:400]})
    return found


def clip_sentence(part, limit=190):
    part = re.sub(r"\s+", " ", part or "").strip()
    if len(part) <= limit:
        return part
    for sep in (":", ";", " — ", " – "):
        idx = part.find(sep)
        if 40 <= idx <= limit:
            left = part[:idx].rstrip(" ,")
            if left[-1:] not in ".!?":
                left += "."
            return left
    comma = part.rfind(",", 0, limit)
    if comma >= 80:
        return part[:comma].rstrip() + "."
    cut = part[:limit].rsplit(" ", 1)[0].rstrip(" ,;:—–")
    return cut + "."


def blurb(text):
    head = text.split("📌")[0]
    head = re.sub(r"^\s*\d{1,2}/\d{1,2}/\d{4}\s*", "", head)
    head = re.sub(r"#\S+", "", head)
    head = re.sub(r"https?://\S+", "", head)
    head = re.sub(r"(?:\+7|8)[\s(]*\d[\d\s\-()]{8,}\d", "", head)
    head = re.sub(r"\s+", " ", head).strip()
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", head) if part.strip()]
    personal = [part for part in parts if re.search(r"(?i)\b(я|мне|меня|мой|моя|моё|мои|мы|нас|наш|зашла|ушла|была|был)\b", part)]
    voice = clip_sentence(personal[0] if personal else (parts[0] if parts else head))
    extra = ""
    for part in personal[1:4]:
        if len(part) > 150:
            continue
        if len(voice) + 1 + len(part) > 250:
            continue
        extra = part
        break
    summary = f"{voice} {extra}".strip()
    summary = re.sub(r"\bрекомендует\b", "рекомендую", summary)
    return summary


def simplify_address(address):
    text = address or ""
    text = re.sub(r"(?i)\bпросп\.", "проспект", text)
    text = re.sub(r"(?i)\bул\.", "улица", text)
    text = re.sub(r"(?i)\bпер\.", "переулок", text)
    text = re.sub(r"(?i)\bнаб\.", "набережная", text)
    text = re.sub(r"(?i),?\s*корп\.[^,]*", "", text)
    return re.sub(r"\s+", " ", text).strip(" ,")


def locate(pin):
    point = coords_from_url(pin.get("yandex"))
    if point:
        return point
    address = simplify_address(pin.get("address"))
    name = pin.get("name") or ""
    queries = []
    if name and address:
        queries.append(f"{name}, {address}")
    if address:
        queries.append(address)
    if name:
        queries.append(name)
    seen = set()
    for query in queries:
        if not query or query in seen:
            continue
        seen.add(query)
        point = geocode(query)
        if point:
            return point
    return None


def verdict_of(text):
    low = text.lower()
    if re.search(r"смешанн\w* чувств", low):
        return "mixed"
    bad = re.search(r"не понравил|разочаров|ужасн|больше не пойду|не зашло|(?<!\w)плох(?:о|ая|ое|ие|ой)\b", low)
    good = re.search(r"понравил|восторг|люблю|вкусно|красив|рекомендую|зашло|хочется вернуться", low)
    if bad and good:
        return "mixed"
    if bad:
        return "dislike"
    return "like"


def visited_on(text, fallback):
    match = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if not match:
        return fallback or None
    day, month, year = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def city_of(text, address):
    tags = re.findall(r"#([^\s@]+)", text)
    for tag in tags:
        if "_" not in tag:
            continue
        suffix = tag.rsplit("_", 1)[-1].lower()
        if suffix in CITY_BY_TAG:
            if suffix == "мск" and re.search(r"московск\w+ обл", address or "", re.I):
                return "Подмосковье"
            return CITY_BY_TAG[suffix]
    return ""


def tags_of(text):
    found = []
    for tag in re.findall(r"#([^\s@]+)", text):
        stem = tag.split("_", 1)[0].lower()
        if stem and stem not in found:
            found.append(stem)
    return found[:8]


def org_id(url):
    match = re.search(r"/org/[^/]+/(\d+)", url or "")
    return match.group(1) if match else ""


def save_photo(msgid, url):
    if not url:
        return ""
    IMAGES.mkdir(exist_ok=True)
    for ext in ("jpg", "jpeg", "png", "webp"):
        path = IMAGES / f"{msgid}.{ext}"
        if path.exists() and path.stat().st_size > 800:
            return f"images/{path.name}"
    try:
        data = fetch(url)
    except Exception as error:
        try:
            request = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
            })
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
        except Exception:
            print(f"фото {msgid} не скачалось: {error}")
            return ""
    if data[:2] == b"\xff\xd8":
        ext = "jpg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ext = "png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = "webp"
    else:
        print(f"фото {msgid} не похоже на картинку")
        return ""
    path = IMAGES / f"{msgid}.{ext}"
    path.write_bytes(data)
    return f"images/{path.name}"


def known_post_ids(places):
    found = set()
    for place in places:
        found.add(post_id(place.get("post")))
        for visit in place.get("visits") or []:
            found.add(post_id(visit.get("post")))
    found.discard("")
    return found


def find_place(places, pin):
    wanted = org_id(pin["yandex"])
    name = pin["name"].casefold()
    for place in places:
        if wanted and org_id(place.get("yandex")) == wanted:
            return place
        if place.get("name", "").casefold() == name:
            return place
    return None


def rollup(place):
    visits = place.get("visits") or []
    if not visits:
        return
    latest = sorted(visits, key=lambda item: item.get("visited") or "", reverse=True)[0]
    place["post"] = latest.get("post")
    place["visited"] = latest.get("visited")
    place["summary"] = latest.get("summary") or place.get("summary") or ""
    if latest.get("image"):
        place["image"] = latest["image"]
    kinds = {item.get("verdict") for item in visits if item.get("verdict")}
    if len(kinds) == 1:
        place["verdict"] = next(iter(kinds))
    elif len(kinds) > 1:
        place["verdict"] = "mixed"


def attach_images(places, messages):
    changed = 0
    for place in places:
        targets = place.get("visits") or []
        if place.get("status") == "wish" and place.get("post"):
            targets = [{"post": place.get("post")}]
        image = ""
        for visit in place.get("visits") or []:
            msgid = post_id(visit.get("post"))
            photo = (messages.get(msgid) or {}).get("photo")
            saved = save_photo(msgid, photo) if photo else ""
            if saved and visit.get("image") != saved:
                visit["image"] = saved
                changed += 1
            image = visit.get("image") or image
        if place.get("status") == "wish":
            msgid = post_id(place.get("post"))
            photo = (messages.get(msgid) or {}).get("photo")
            saved = save_photo(msgid, photo) if photo else ""
            if saved and place.get("image") != saved:
                place["image"] = saved
                changed += 1
        elif image and place.get("image") != image:
            place["image"] = image
            changed += 1
    return changed


def add_new(places, messages):
    known = known_post_ids(places)
    added = []
    for msgid in sorted(messages, key=int):
        if msgid in known:
            continue
        message = messages[msgid]
        text = message["text"]
        found = pins(text)
        if not found or len(text) < 40:
            continue
        summary = blurb(text) or "Новый пост в канале."
        verdict = verdict_of(text)
        when = visited_on(text, message["date"])
        image = save_photo(msgid, message["photo"])
        url = f"https://t.me/ya_tam_byl/{msgid}"
        for index, pin in enumerate(found):
            point = locate(pin)
            if not point:
                print(f"пропускаю {url}: нет координат для «{pin['name']}»")
                continue
            visit = {
                "post": url,
                "summary": summary,
                "visited": when,
                "verdict": verdict,
            }
            if image:
                visit["image"] = image
            existing = find_place(places, pin)
            if existing and existing.get("status") != "wish":
                visits = existing.setdefault("visits", [])
                if any(item.get("post") == url for item in visits):
                    continue
                visits.append(visit)
                rollup(existing)
                added.append(f"ещё пост: {existing['name']}")
                continue
            ident = f"p-{msgid}" if len(found) == 1 else f"p-{msgid}-{index + 1}"
            if any(place.get("id") == ident for place in places):
                ident = f"{ident}-b"
            lat, lon = point
            yandex = pin["yandex"] or f"https://yandex.ru/maps/?pt={lon},{lat}&z=16&l=map"
            place = {
                "id": ident,
                "name": pin["name"],
                "status": "been",
                "verdict": verdict,
                "city": city_of(text, pin["address"]),
                "visited": when,
                "post": url,
                "visits": [visit],
                "address": pin["address"],
                "tags": tags_of(text),
                "lat": lat,
                "lon": lon,
                "yandex": yandex,
                "summary": summary,
            }
            if image:
                place["image"] = image
            places.append(place)
            added.append(f"новое место: {pin['name']}")
        known.add(msgid)
    return added


def write(places):
    payload = json.dumps(places, ensure_ascii=False, indent=2)
    PLACES.write_text(payload + "\n", encoding="utf-8")
    JS.write_text("window.PLACES = " + payload + ";\n", encoding="utf-8")


def main():
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    messages = scrape()
    print(f"постов в канале: {len(messages)}")
    photos = attach_images(places, messages)
    added = add_new(places, messages)
    write(places)
    print(f"фото обновлено: {photos}")
    if added:
        print("\n".join(added))
    else:
        print("новых мест нет")


if __name__ == "__main__":
    main()
