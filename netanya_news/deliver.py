"""Hand the daily content package to an external marketing system (e.g. AS BIZ) over a webhook."""
import json
import os
import urllib.request

from . import instagram


def deliver(package, image_path, video_path, day):
    """Uploads media to the public bucket, then POSTs the package JSON to ASBIZ_WEBHOOK_URL."""
    package = dict(package, image_url=instagram.upload_public(image_path, f"{day}.jpg"))
    if video_path:
        package["video_url"] = instagram.upload_public(video_path, f"{day}.mp4", "video/mp4")
    headers = {"Content-Type": "application/json"}
    if os.environ.get("ASBIZ_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["ASBIZ_TOKEN"]
    req = urllib.request.Request(os.environ["ASBIZ_WEBHOOK_URL"], json.dumps(package, ensure_ascii=False).encode(), headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return f"HTTP {r.status}"
