"""Publish an image to Instagram via the Graph API (Business/Creator account).

Instagram only accepts a *public image URL*, so the card is first uploaded to a public
Supabase Storage bucket.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

GRAPH = "https://graph.facebook.com/v21.0"


def _req(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{url.split('?')[0]} -> {e.code}: {e.read().decode(errors='replace')[:300]}") from None


def upload_public(path, name, content_type="image/jpeg"):
    base, key, bucket = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"], os.environ.get("SUPABASE_BUCKET", "netanya-news")
    _req(f"{base}/storage/v1/object/{bucket}/{name}", open(path, "rb").read(),
         {"Authorization": f"Bearer {key}", "Content-Type": content_type, "x-upsert": "true"}, "POST")
    return f"{base}/storage/v1/object/public/{bucket}/{name}"


def _post(path, **params):
    params["access_token"] = os.environ["IG_ACCESS_TOKEN"]
    return _req(f"{GRAPH}/{path}", urllib.parse.urlencode(params).encode(), method="POST")


def publish(image_path, caption, date_str):
    ig = os.environ["IG_USER_ID"]
    url = upload_public(image_path, f"{date_str}.jpg")
    container = _post(f"{ig}/media", image_url=url, caption=caption)["id"]
    for _ in range(15):  # wait for the container to be ready
        st = _req(f"{GRAPH}/{container}?fields=status_code&access_token={os.environ['IG_ACCESS_TOKEN']}")
        if st.get("status_code") == "FINISHED":
            break
        if st.get("status_code") == "ERROR":
            raise RuntimeError("Instagram container processing failed")
        time.sleep(2)
    media_id = _post(f"{ig}/media_publish", creation_id=container)["id"]
    info = _req(f"{GRAPH}/{media_id}?fields=permalink&access_token={os.environ['IG_ACCESS_TOKEN']}")
    return info.get("permalink", "")
