"""Collect Netanya-related items from RSS/Atom feeds and Google News searches."""
import html
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

UA = {"User-Agent": "Mozilla/5.0 (compatible; NetanyaNewsBot/1.0)"}


def _fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def _text(el, *names):
    for n in names:
        found = el.find(n)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return ""


def _clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _parse_date(s):
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse_feed(xml_bytes, default_source):
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter():
        tag = it.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        link = _text(it, "link")
        if not link:
            for l in it:
                if l.tag.split("}")[-1] == "link" and l.get("href"):
                    link = l.get("href")
        title = _clean(_text(it, "title"))
        source = default_source
        src_el = next((c for c in it if c.tag.split("}")[-1] == "source"), None)
        if src_el is not None and (src_el.text or "").strip():
            source = src_el.text.strip()
            title = re.sub(r"\s+-\s+" + re.escape(source) + r"$", "", title)
        pub = _parse_date(_text(it, "pubDate", "{http://www.w3.org/2005/Atom}published",
                                "{http://www.w3.org/2005/Atom}updated", "published", "updated"))
        summary = _clean(_text(it, "description", "{http://www.w3.org/2005/Atom}summary", "summary"))
        if title and link:
            items.append({"title": title, "url": link, "source": source,
                          "published": pub.isoformat() if pub else None, "snippet": summary[:400]})
    return items


def _norm(t):
    return set(re.findall(r"\w+", t.lower()))


def dedupe(items, threshold=0.7):
    kept = []
    for it in items:
        toks = _norm(it["title"])
        if any(len(toks & k) / max(1, len(toks | k)) >= threshold for k in (_norm(x["title"]) for x in kept)):
            continue
        kept.append(it)
    return kept


def collect(config_path="sources.json", now=None, log=print):
    cfg = json.load(open(config_path, encoding="utf-8"))
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=cfg.get("max_age_hours", 30))
    kw = cfg["keyword"]

    jobs = [("google", q, "https://news.google.com/rss/search?q=" +
             urllib.parse.quote(q + " when:2d") + "&hl=he&gl=IL&ceid=IL:he", q) for q in cfg["google_news_queries"]]
    jobs += [("feed", f["name"], f["url"], None) for f in cfg["feeds"]]

    items = []
    for kind, name, url, _ in jobs:
        try:
            got = parse_feed(_fetch(url), name)
        except Exception as e:  # one broken source must not kill the run
            log(f"[collect] {name}: failed ({e})")
            continue
        if kind == "feed":
            got = [i for i in got if kw in i["title"] or kw in i["snippet"]]
        log(f"[collect] {name}: {len(got)} items")
        items += got

    fresh = []
    for i in items:
        p = _parse_date(i["published"])
        if p is None or p >= cutoff:
            fresh.append(i)
    fresh.sort(key=lambda i: i["published"] or "", reverse=True)
    return dedupe(fresh)
