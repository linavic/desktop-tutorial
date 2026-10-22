"""Telegram alerts to the channel owner."""
import json
import os
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
        body += (f'--{b}\r\nContent-Disposition: form-data; name="{name}"; filename="card.jpg"\r\n'
                 f"Content-Type: image/jpeg\r\n\r\n").encode() + open(path, "rb").read() + f"\r\n--{b}--\r\n".encode()
        req = urllib.request.Request(url, body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    else:
        req = urllib.request.Request(url, json.dumps(fields).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def configured():
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def send_text(text):
    _api("sendMessage", {"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text[:4000], "disable_web_page_preview": True})


def send_package(headline, image_path, whatsapp_text):
    """Alert + the card image + the ready-to-paste WhatsApp text as a separate message."""
    chat = os.environ["TELEGRAM_CHAT_ID"]
    _api("sendPhoto", {"chat_id": chat, "caption": headline[:1000]}, ("photo", image_path))
    send_text(whatsapp_text)
