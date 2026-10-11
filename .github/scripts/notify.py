#!/usr/bin/env python3
"""Sends one phone notification (through ntfy) built from the site's data.

Usage: notify.py morning | task | gre | test
The topic name comes from the NTFY_TOPIC secret, never from this file. Reads the database; changes nothing.
"""
import datetime
import json
import os
import re
import sys
import urllib.request
from zoneinfo import ZoneInfo

PROJECT = "badriyahstasks"
API_KEY = "AIzaSyD5Enp6XOf64EEBnjDf6A2NsKxG_GTW36M"  # the site's public web key (also in app.js)
BASE = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % PROJECT
SITE = "https://badriyahs.github.io/BadriyahsTasks/"


def docs(name):
    out, token = [], None
    while True:
        url = "%s/%s?pageSize=300&key=%s%s" % (BASE, name, API_KEY, ("&pageToken=" + token) if token else "")
        data = json.load(urllib.request.urlopen(url, timeout=60))
        for d in data.get("documents", []):
            row = {"id": d["name"].rsplit("/", 1)[-1]}
            for k, v in d.get("fields", {}).items():
                row[k] = v.get("stringValue", v.get("booleanValue", v.get("integerValue", "")))
            out.append(row)
        token = data.get("nextPageToken")
        if not token:
            return out


def clip(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


today = datetime.datetime.now(ZoneInfo("Asia/Kuwait")).date()
t = today.isoformat()
order = lambda x: float(x.get("order", 0) or 0)


def open_leaf_tasks():
    tasks = [x for x in docs("tasks") if not x.get("archived") and not x.get("struck") and (x.get("description") or "").strip()]
    nos = [x.get("no", "") for x in tasks]
    return [x for x in tasks if x.get("no") and not any(n.startswith(x["no"] + ".") for n in nos)]


def morning():
    tasks = open_leaf_tasks()
    due_today = sorted([x for x in tasks if x.get("due") == t], key=order)
    overdue = [x for x in tasks if x.get("due") and x["due"] < t and not (x.get("dependency") or "").strip()]
    events = [e for e in docs("events") if not e.get("archived") and not e.get("struck") and e.get("due") == t]
    parts = []
    for e in events[:3]:
        m = re.search(r"(\d{1,2}(?::\d{2})?\s*[AP]M)", e.get("details", ""), re.I)
        parts.append(clip(e.get("description", ""), 40) + (" at " + m.group(1).upper() if m else ""))
    if due_today:
        parts.append("Due: " + "; ".join(clip(x["description"], 40) for x in due_today[:3]) + (" +%d more" % (len(due_today) - 3) if len(due_today) > 3 else ""))
    if overdue:
        parts.append("%d overdue" % len(overdue))
    return "Today", ("\n".join(parts) if parts else "Nothing scheduled today. A calm day."), "index.html"


def task():
    tasks = open_leaf_tasks()
    soon_end = (today + datetime.timedelta(days=3)).isoformat()
    groups = (
        (sorted([x for x in tasks if x.get("due") == t], key=order), "due today"),
        (sorted([x for x in tasks if x.get("due") and t < x["due"] <= soon_end], key=lambda x: (x["due"], order(x))), "coming up"),
        (sorted([x for x in tasks if x.get("due") and x["due"] < t and not (x.get("dependency") or "").strip()], key=lambda x: (x["due"], order(x))), "overdue"),
    )
    for group, label in groups:
        if group:
            return "Your task (%s)" % label, clip(group[0]["description"], 150), "tasks.html#task-" + group[0]["id"]
    return None


def gre():
    items = [g for g in docs("gre") if g["id"] != "_settings" and g.get("date")]
    once = lambda g: g["id"][:3] == "dx-" or g["id"][:4] == "rev-"
    left = [g for g in items if g["date"] <= t and not (g.get("done") if once(g) else g.get("study"))]
    left.sort(key=lambda g: (g["date"], order(g)))
    if not left:
        return "GRE", "You're caught up for today.", "gre.html"
    g = left[0]
    behind = " (from %s)" % g["date"][5:] if g["date"] < t else ""
    return "GRE chapter", clip(g.get("title", ""), 150) + behind + "\nTick it on the GRE tab when done.", "gre.html"


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else "test"
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        print("NTFY_TOPIC is not set")
        return 1
    result = {"morning": morning, "task": task, "gre": gre,
              "test": lambda: ("Test", "Your notifications are set up. You'll get your day at 8:00, a task at 4:00 and your GRE chapter at 4:05.", "index.html")}[kind]()
    if not result:
        print("Nothing to send for", kind)
        return 0
    title, body, page = result
    req = urllib.request.Request("https://ntfy.sh/" + topic, data=body.encode("utf-8"), method="POST",
                                 headers={"Title": title, "Click": SITE + page, "Tags": "sunrise" if kind == "morning" else "pushpin"})
    urllib.request.urlopen(req, timeout=30).read()
    print("Sent:", title, "|", body.replace("\n", " / "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
