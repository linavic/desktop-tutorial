"""Telegram alerts to the channel owner."""
import json
import os
import urllib.error
import urllib.request
import uuid


def _api(method, fields, file_field=None):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    url = f"https://api.telegram.org/bot{token}/{method}"
    if file_field:
        b = uuid.uuid4().hex
        body = b""
        for k, v in fields.items():
            body += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        name, path = file_field
        body += (f'--{b}\r\nContent-Disposition: form-data; name="{name}"; filename="{os.path.basename(path)}"\r\n'
                 f"Content-Type: {'video/mp4' if path.endswith('.mp4') else 'image/jpeg'}\r\n\r\n").encode() + open(path, "rb").read() + f"\r\n--{b}--\r\n".encode()
        req = urllib.request.Request(url, body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    else:
        req = urllib.request.Request(url, json.dumps(fields).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:  # surface Telegram's own explanation (e.g. "chat not found")
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Telegram {method} -> {e.code}: {detail}") from None


def configured():
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def send_text(text, chat=None):
    _api("sendMessage", {"chat_id": chat or os.environ["TELEGRAM_CHAT_ID"], "text": text[:4000], "disable_web_page_preview": True})


def post_to_channel(image_path, html_text):
    """Public post to the Telegram channel (bot must be a channel admin). Returns the post link if public."""
    chan = os.environ["TELEGRAM_CHANNEL_ID"]  # e.g. @netanya_news_daily
    _api("sendPhoto", {"chat_id": chan}, ("photo", image_path))
    res = _api("sendMessage", {"chat_id": chan, "text": html_text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True})
    uname = res["result"]["chat"].get("username")
    return f"https://t.me/{uname}/{res['result']['message_id']}" if uname else ""


def send_package(headline, image_path, whatsapp_text):
    """Alert + the card image + the ready-to-paste WhatsApp text as a separate message."""
    chat = os.environ["TELEGRAM_CHAT_ID"]
    _api("sendPhoto", {"chat_id": chat, "caption": headline[:1000]}, ("photo", image_path))
    send_text(whatsapp_text)


def send_video(video_path, caption=""):
    _api("sendVideo", {"chat_id": os.environ["TELEGRAM_CHAT_ID"], "caption": caption[:1000], "supports_streaming": "true"}, ("video", video_path))
