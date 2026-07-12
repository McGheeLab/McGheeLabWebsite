#!/usr/bin/env python3
"""
Slack → Lab Chat one-time history export.

Pulls users, channels (public + private + DMs + group DMs), messages, threads,
reactions, and files from a Slack workspace and writes them into the McGheeLab
Lab Chat Firestore schema. Idempotent on `slackTs` so it can be resumed.

Usage:
    python3 scripts/slack_export.py --dry-run
    python3 scripts/slack_export.py --channels general,announcements
    python3 scripts/slack_export.py --skip-files
    python3 scripts/slack_export.py                  # full run

Required env (in scripts/.env or process env):
    SLACK_USER_TOKEN     workspace-owner xoxp- token (see scripts/.env.example)
    FIREBASE_SA_PATH     path to Firebase service account JSON
    FIREBASE_PROJECT_ID  Firebase project id (e.g. mcgheelab)
    FIREBASE_BUCKET      Storage bucket (e.g. mcgheelab.appspot.com)
    IMPORTER_UID         UID to credit as creator of imported channels
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
    import firebase_admin
    from firebase_admin import credentials, firestore, storage
    import requests
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Install with: pip install -r scripts/requirements.txt")
    sys.exit(1)


SCRIPT_DIR = Path(__file__).resolve().parent
CHECKPOINT_PATH = SCRIPT_DIR / ".slack_export_checkpoint.json"
ENV_PATH = SCRIPT_DIR / ".env"

MAX_FILE_BYTES = 50 * 1024 * 1024  # matches storage.rules
SLACK_HISTORY_PAGE = 200            # max allowed by API
RATE_LIMIT_SLEEP = 1.2              # seconds between Tier 3 calls
FIRESTORE_BATCH_SIZE = 400          # under 500 limit, leaves room for parent updates


# ──────────────────────────────────────────────────────────────────────────
# Checkpoint
# ──────────────────────────────────────────────────────────────────────────

def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        return json.loads(CHECKPOINT_PATH.read_text())
    return {"channels_done": [], "user_map": {}, "started_at": None}


def save_checkpoint(state: dict) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(state, indent=2))


# ──────────────────────────────────────────────────────────────────────────
# Slack: paginated fetchers with rate-limit handling
# ──────────────────────────────────────────────────────────────────────────

def slack_call(fn, **kwargs):
    """Call a slack_sdk method, sleep through rate limits, retry once on 429."""
    while True:
        try:
            resp = fn(**kwargs)
            time.sleep(RATE_LIMIT_SLEEP)
            return resp
        except SlackApiError as e:
            if e.response.status_code == 429:
                retry_after = int(e.response.headers.get("Retry-After", "30"))
                print(f"  rate-limited, sleeping {retry_after}s")
                time.sleep(retry_after + 1)
                continue
            raise


def fetch_all_users(slack: WebClient) -> dict:
    """Returns {slack_user_id: {id, name, real_name, email, image_72, deleted, is_bot}}."""
    print("Fetching Slack users…")
    users = {}
    cursor = None
    while True:
        resp = slack_call(slack.users_list, limit=200, cursor=cursor)
        for u in resp["members"]:
            users[u["id"]] = {
                "id": u["id"],
                "name": u.get("name") or "",
                "real_name": (u.get("profile", {}).get("real_name")
                              or u.get("real_name") or u.get("name") or ""),
                "display_name": u.get("profile", {}).get("display_name") or "",
                "email": u.get("profile", {}).get("email") or "",
                "image": u.get("profile", {}).get("image_72") or "",
                "deleted": u.get("deleted", False),
                "is_bot": u.get("is_bot", False),
            }
        cursor = resp.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            break
    print(f"  found {len(users)} users")
    return users


def fetch_all_channels(slack: WebClient) -> list:
    """Public + private + DMs + group DMs the user token can see."""
    print("Fetching Slack channels…")
    channels = []
    cursor = None
    types = "public_channel,private_channel,mpim,im"
    while True:
        resp = slack_call(slack.conversations_list,
                          types=types, limit=200, cursor=cursor)
        channels.extend(resp["channels"])
        cursor = resp.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            break
    print(f"  found {len(channels)} conversations")
    return channels


def fetch_history(slack: WebClient, channel_id: str):
    """Yield top-level messages (oldest → newest)."""
    cursor = None
    pages = []
    while True:
        resp = slack_call(slack.conversations_history,
                          channel=channel_id,
                          limit=SLACK_HISTORY_PAGE,
                          cursor=cursor)
        pages.extend(resp["messages"])
        cursor = resp.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            break
    pages.sort(key=lambda m: float(m["ts"]))
    return pages


def fetch_replies(slack: WebClient, channel_id: str, thread_ts: str):
    """Yield thread replies (excluding parent), oldest → newest."""
    cursor = None
    out = []
    while True:
        resp = slack_call(slack.conversations_replies,
                          channel=channel_id, ts=thread_ts,
                          limit=SLACK_HISTORY_PAGE, cursor=cursor)
        out.extend(resp["messages"])
        cursor = resp.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            break
    out = [m for m in out if m.get("ts") != thread_ts]
    out.sort(key=lambda m: float(m["ts"]))
    return out


# ──────────────────────────────────────────────────────────────────────────
# User mapping (Slack user → Firestore uid)
# ──────────────────────────────────────────────────────────────────────────

def build_user_map(db, slack_users: dict, importer_uid: str, dry_run: bool) -> dict:
    """
    Returns {slack_id: firestore_uid}. Matches by email against existing
    users/{uid}.email; creates ghost users/slack_{slack_id} for unmatched.
    """
    print("Mapping Slack users to Lab Chat UIDs…")
    existing_by_email = {}
    for snap in db.collection("users").stream():
        data = snap.to_dict() or {}
        email = (data.get("email") or "").lower().strip()
        if email:
            existing_by_email[email] = snap.id

    user_map = {}
    ghosts_created = 0
    for sid, su in slack_users.items():
        if sid == "USLACKBOT":
            continue
        email = (su["email"] or "").lower().strip()
        if email and email in existing_by_email:
            user_map[sid] = existing_by_email[email]
            continue

        ghost_uid = f"slack_{sid}"
        user_map[sid] = ghost_uid
        if dry_run:
            ghosts_created += 1
            continue

        ghost_ref = db.collection("users").document(ghost_uid)
        if not ghost_ref.get().exists:
            ghost_ref.set({
                "name": su["real_name"] or su["display_name"] or su["name"],
                "displayName": su["display_name"] or su["real_name"] or su["name"],
                "email": su["email"],
                "photo": {"thumb": su["image"]} if su["image"] else None,
                "role": "guest",
                "imported": True,
                "disabled": True,
                "slackUserId": sid,
                "createdAt": firestore.SERVER_TIMESTAMP,
                "createdBy": importer_uid,
            })
            ghosts_created += 1

    print(f"  matched {len(user_map) - ghosts_created} existing, created {ghosts_created} ghost users")
    return user_map


# ──────────────────────────────────────────────────────────────────────────
# Channel mapping
# ──────────────────────────────────────────────────────────────────────────

def channel_doc_id(slack_channel_id: str) -> str:
    return f"slack_{slack_channel_id}"


def channel_display_name(slack_channel: dict, slack_users: dict, user_map: dict) -> tuple:
    """Returns (name, displayName, type, members_uids)."""
    sid = slack_channel["id"]
    if slack_channel.get("is_im"):
        # 1:1 DM
        other_id = slack_channel.get("user")
        other = slack_users.get(other_id, {})
        label = other.get("real_name") or other.get("name") or other_id
        members = [user_map[other_id]] if other_id in user_map else []
        return (f"slack-dm-{sid}", f"DM with {label} (Slack)", "dm", members)
    if slack_channel.get("is_mpim"):
        # group DM — name is mpdm-name1--name2--...
        members_ids = slack_channel.get("members") or []
        members = [user_map[m] for m in members_ids if m in user_map]
        labels = [slack_users.get(m, {}).get("real_name") or m for m in members_ids]
        return (f"slack-gdm-{sid}", f"Group DM: {', '.join(labels[:3])} (Slack)", "dm", members)
    # public/private channel
    cname = slack_channel.get("name") or sid
    return (f"slack-{cname}", f"#{cname} (Slack archive)", "channel", [])


def ensure_channel_doc(db, slack_channel: dict, slack_users: dict, user_map: dict,
                       importer_uid: str, dry_run: bool):
    sid = slack_channel["id"]
    doc_id = channel_doc_id(sid)
    name, display, ctype, members = channel_display_name(slack_channel, slack_users, user_map)

    created_ts = slack_channel.get("created")
    created_dt = datetime.fromtimestamp(created_ts, tz=timezone.utc) if created_ts else None

    data = {
        "name": name,
        "displayName": display,
        "description": slack_channel.get("purpose", {}).get("value") or "",
        "category": "Slack archive",
        "type": ctype,
        "isDefault": False,
        "isAnnouncement": False,
        "importedFromSlack": True,
        "slackChannelId": sid,
        "members": members,
        "pinnedMessageIds": [],
        "memberCount": len(members),
        "messageCount": 0,
        "createdBy": importer_uid,
        "createdAt": created_dt or firestore.SERVER_TIMESTAMP,
    }
    if dry_run:
        print(f"  [dry] would upsert chatChannels/{doc_id}: {display}")
        return doc_id

    ref = db.collection("chatChannels").document(doc_id)
    if ref.get().exists:
        ref.update({
            "displayName": display,
            "description": data["description"],
            "members": members,
            "memberCount": len(members),
            "importedFromSlack": True,
        })
    else:
        ref.set(data)
    return doc_id


def add_slack_archive_category(db, dry_run: bool):
    """Append 'Slack archive' to chatConfig/settings.categories if absent."""
    if dry_run:
        return
    ref = db.collection("chatConfig").document("settings")
    snap = ref.get()
    cats = (snap.to_dict() or {}).get("categories", []) if snap.exists else []
    if "Slack archive" not in cats:
        cats.append("Slack archive")
        ref.set({"categories": cats}, merge=True)


# ──────────────────────────────────────────────────────────────────────────
# Message conversion
# ──────────────────────────────────────────────────────────────────────────

MENTION_USER = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]+)?>")
MENTION_CHANNEL = re.compile(r"<#([CG][A-Z0-9]+)(?:\|([^>]+))?>")
LINK_LABELED = re.compile(r"<(https?://[^|>]+)\|([^>]+)>")
LINK_BARE = re.compile(r"<(https?://[^>]+)>")
SPECIAL_MENTION = re.compile(r"<!(channel|here|everyone)>")
EMAIL_LINK = re.compile(r"<mailto:([^|>]+)(?:\|[^>]+)?>")


def convert_text(text: str, slack_users: dict, user_map: dict,
                 channel_id_to_name: dict) -> tuple:
    """Returns (converted_text, [resolved_uids_for_mentions])."""
    if not text:
        return "", []
    mentions_out = []

    def sub_user(m):
        sid = m.group(1)
        uid = user_map.get(sid)
        if uid:
            mentions_out.append(uid)
        label = slack_users.get(sid, {}).get("real_name") or slack_users.get(sid, {}).get("name") or sid
        return f"@{label}"

    def sub_channel(m):
        sid = m.group(1)
        name = m.group(2) or channel_id_to_name.get(sid) or sid
        return f"#{name}"

    text = MENTION_USER.sub(sub_user, text)
    text = MENTION_CHANNEL.sub(sub_channel, text)
    text = LINK_LABELED.sub(lambda m: f"{m.group(2)} ({m.group(1)})", text)
    text = LINK_BARE.sub(lambda m: m.group(1), text)
    text = SPECIAL_MENTION.sub(lambda m: f"@{m.group(1)}", text)
    text = EMAIL_LINK.sub(lambda m: m.group(1), text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return text, mentions_out


def convert_reactions(reactions: list, user_map: dict) -> dict:
    out = {}
    for r in reactions or []:
        uids = [user_map[u] for u in r.get("users", []) if u in user_map]
        if uids:
            out[r["name"]] = uids
    return out


def slack_ts_to_datetime(ts: str) -> datetime:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


# ──────────────────────────────────────────────────────────────────────────
# Files
# ──────────────────────────────────────────────────────────────────────────

def import_slack_files(slack_token: str, bucket, slack_files: list,
                       slack_channel_id: str, slack_ts: str, dry_run: bool):
    """Returns list of file dicts in Lab Chat schema, or [] if none."""
    out = []
    for f in slack_files or []:
        size = f.get("size") or 0
        name = f.get("name") or "file"
        url = f.get("url_private_download") or f.get("url_private")
        if not url:
            continue
        if size > MAX_FILE_BYTES:
            print(f"    skipping {name} ({size} bytes > 50MB limit)")
            continue
        content_type = f.get("mimetype") or "application/octet-stream"
        is_image = content_type.startswith("image/")
        storage_path = f"chat/imported/{slack_channel_id}/{slack_ts}_{name}"

        if dry_run:
            out.append({
                "url": "[dry-run]", "storagePath": storage_path,
                "name": name, "size": size,
                "contentType": content_type, "isImage": is_image,
            })
            continue

        try:
            r = requests.get(url, headers={"Authorization": f"Bearer {slack_token}"},
                             timeout=120)
            r.raise_for_status()
            blob = bucket.blob(storage_path)
            blob.upload_from_string(r.content, content_type=content_type)
            blob.make_public()  # imported archive is reachable like other chat files
            out.append({
                "url": blob.public_url,
                "storagePath": storage_path,
                "name": name,
                "size": size,
                "contentType": content_type,
                "isImage": is_image,
            })
        except Exception as e:
            print(f"    file import failed for {name}: {e}")
    return out


# ──────────────────────────────────────────────────────────────────────────
# Message writes
# ──────────────────────────────────────────────────────────────────────────

def message_already_imported(db, slack_channel_id: str, slack_ts: str) -> str | None:
    """Return existing firestore message id if this slackTs is already imported."""
    q = (db.collection("chatMessages")
           .where("slackChannelId", "==", slack_channel_id)
           .where("slackTs", "==", slack_ts)
           .limit(1).stream())
    for snap in q:
        return snap.id
    return None


def build_message_doc(slack_msg: dict, channel_id: str, slack_channel_id: str,
                      slack_users: dict, user_map: dict, channel_id_to_name: dict,
                      file_refs: list, importer_uid: str) -> dict:
    sid = slack_msg.get("user") or slack_msg.get("bot_id") or "USLACKBOT"
    author_uid = user_map.get(sid) or f"slack_{sid}"
    su = slack_users.get(sid, {})
    text, mentions = convert_text(slack_msg.get("text", ""),
                                  slack_users, user_map, channel_id_to_name)

    # If the message has files but no text, give it a placeholder so search has something to grab
    if not text and file_refs:
        text = f"[shared {len(file_refs)} file{'s' if len(file_refs) > 1 else ''}]"

    primary_file = file_refs[0] if file_refs else None
    edited_at = None
    if slack_msg.get("edited", {}).get("ts"):
        edited_at = slack_ts_to_datetime(slack_msg["edited"]["ts"])

    return {
        "channelId": channel_id,
        "authorUid": author_uid,
        "authorName": (su.get("real_name") or su.get("name")
                       or slack_msg.get("username") or "Slack user"),
        "authorPhoto": su.get("image") or None,
        "text": text,
        "type": "file" if primary_file else "text",
        "file": primary_file,
        "files": file_refs if len(file_refs) > 1 else None,
        "mentions": mentions,
        "mentionsChannel": False,  # don't replay historical @channel pings
        "threadParentId": None,    # filled in pass 2
        "threadReplyCount": 0,
        "threadLastReplyAt": None,
        "reactions": convert_reactions(slack_msg.get("reactions"), user_map),
        "readBy": [],
        "editedAt": edited_at,
        "deleted": False,
        "pinned": bool(slack_msg.get("pinned_to")),
        "createdAt": slack_ts_to_datetime(slack_msg["ts"]),
        "importedFromSlack": True,
        "slackTs": slack_msg["ts"],
        "slackChannelId": slack_channel_id,
        "importedBy": importer_uid,
    }


# ──────────────────────────────────────────────────────────────────────────
# Per-channel pipeline
# ──────────────────────────────────────────────────────────────────────────

def process_channel(slack: WebClient, db, bucket, slack_token: str,
                    slack_channel: dict, slack_users: dict, user_map: dict,
                    channel_id_to_name: dict, importer_uid: str,
                    skip_files: bool, dry_run: bool):
    sid = slack_channel["id"]
    label = slack_channel.get("name") or sid
    print(f"\n=== Channel: {label} ({sid}) ===")

    chat_channel_id = ensure_channel_doc(
        db, slack_channel, slack_users, user_map, importer_uid, dry_run)

    messages = fetch_history(slack, sid)
    print(f"  {len(messages)} top-level messages")

    # Pass 1: top-level messages, build slackTs → firestoreId map
    ts_to_id = {}
    written_count = 0
    skipped_count = 0
    last_msg_for_channel = None

    for i, m in enumerate(messages, 1):
        if m.get("subtype") in ("channel_join", "channel_leave"):
            continue
        ts = m["ts"]
        existing = None if dry_run else message_already_imported(db, sid, ts)
        if existing:
            ts_to_id[ts] = existing
            skipped_count += 1
            continue

        files = [] if skip_files else import_slack_files(
            slack_token, bucket, m.get("files"), sid, ts, dry_run)

        doc = build_message_doc(m, chat_channel_id, sid, slack_users, user_map,
                                channel_id_to_name, files, importer_uid)
        if dry_run:
            ts_to_id[ts] = f"[dry-{ts}]"
            written_count += 1
        else:
            ref = db.collection("chatMessages").document()
            ref.set(doc)
            ts_to_id[ts] = ref.id
            written_count += 1

        last_msg_for_channel = doc

        if i % 50 == 0:
            print(f"  pass1 {i}/{len(messages)}")

    # Pass 2: thread replies for messages that have them
    thread_parents = [m for m in messages
                      if m.get("thread_ts") == m["ts"] and (m.get("reply_count") or 0) > 0]
    print(f"  {len(thread_parents)} threads to expand")

    for tp in thread_parents:
        replies = fetch_replies(slack, sid, tp["ts"])
        if not replies:
            continue
        parent_id = ts_to_id.get(tp["ts"])
        if not parent_id:
            continue
        latest_reply_dt = None
        for r in replies:
            ts = r["ts"]
            existing = None if dry_run else message_already_imported(db, sid, ts)
            if existing:
                continue
            files = [] if skip_files else import_slack_files(
                slack_token, bucket, r.get("files"), sid, ts, dry_run)
            doc = build_message_doc(r, chat_channel_id, sid, slack_users, user_map,
                                    channel_id_to_name, files, importer_uid)
            doc["threadParentId"] = parent_id
            if dry_run:
                written_count += 1
            else:
                db.collection("chatMessages").document().set(doc)
                written_count += 1
            latest_reply_dt = doc["createdAt"]

        if not dry_run and parent_id and not parent_id.startswith("[dry-"):
            db.collection("chatMessages").document(parent_id).update({
                "threadReplyCount": len(replies),
                "threadLastReplyAt": latest_reply_dt,
            })

    # Channel summary
    if not dry_run and last_msg_for_channel:
        last_text = last_msg_for_channel.get("text") or ""
        if last_msg_for_channel.get("file"):
            last_text = f"📎 {last_msg_for_channel['file']['name']}"
        db.collection("chatChannels").document(chat_channel_id).update({
            "lastMessage": {
                "text": last_text[:100],
                "authorName": last_msg_for_channel["authorName"],
                "authorUid": last_msg_for_channel["authorUid"],
                "timestamp": last_msg_for_channel["createdAt"],
            },
            "lastActivityAt": last_msg_for_channel["createdAt"],
            "messageCount": written_count,
        })

    print(f"  → wrote {written_count}, skipped {skipped_count} (already imported)")
    return chat_channel_id


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Slack → Lab Chat history export")
    parser.add_argument("--dry-run", action="store_true",
                        help="Walk Slack but don't write to Firestore/Storage")
    parser.add_argument("--channels", type=str, default="",
                        help="Comma-separated Slack channel names or ids to limit to")
    parser.add_argument("--skip-files", action="store_true",
                        help="Don't download/upload file attachments")
    parser.add_argument("--skip-dms", action="store_true",
                        help="Skip 1:1 and group DMs (public/private channels only)")
    args = parser.parse_args()

    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)

    slack_token = os.environ.get("SLACK_USER_TOKEN")
    sa_path = os.environ.get("FIREBASE_SA_PATH")
    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    bucket_name = os.environ.get("FIREBASE_BUCKET")
    importer_uid = os.environ.get("IMPORTER_UID")
    missing = [k for k, v in {
        "SLACK_USER_TOKEN": slack_token, "FIREBASE_SA_PATH": sa_path,
        "FIREBASE_PROJECT_ID": project_id, "FIREBASE_BUCKET": bucket_name,
        "IMPORTER_UID": importer_uid,
    }.items() if not v]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}")
        print(f"Copy {ENV_PATH.with_name('.env.example')} to {ENV_PATH} and fill it in.")
        sys.exit(1)

    slack = WebClient(token=slack_token)

    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred, {
            "projectId": project_id,
            "storageBucket": bucket_name,
        })
    db = firestore.client()
    bucket = storage.bucket() if not args.dry_run else None

    state = load_checkpoint()
    if not state.get("started_at"):
        state["started_at"] = datetime.now(timezone.utc).isoformat()

    slack_users = fetch_all_users(slack)
    slack_channels = fetch_all_channels(slack)
    channel_id_to_name = {c["id"]: c.get("name") for c in slack_channels if c.get("name")}

    user_map = build_user_map(db, slack_users, importer_uid, args.dry_run)
    state["user_map"] = user_map
    save_checkpoint(state)

    add_slack_archive_category(db, args.dry_run)

    # Filter channels
    wanted = set(s.strip() for s in args.channels.split(",") if s.strip())
    todo_channels = []
    for c in slack_channels:
        if args.skip_dms and (c.get("is_im") or c.get("is_mpim")):
            continue
        if wanted and not (c.get("name") in wanted or c["id"] in wanted):
            continue
        if c["id"] in state["channels_done"]:
            print(f"  skipping {c.get('name') or c['id']} (already in checkpoint)")
            continue
        todo_channels.append(c)

    print(f"\nProcessing {len(todo_channels)} channels"
          f"{' (DRY RUN)' if args.dry_run else ''}")

    for c in todo_channels:
        try:
            process_channel(slack, db, bucket, slack_token, c,
                            slack_users, user_map, channel_id_to_name,
                            importer_uid, args.skip_files, args.dry_run)
            state["channels_done"].append(c["id"])
            save_checkpoint(state)
        except KeyboardInterrupt:
            print("\nInterrupted — checkpoint saved, re-run to resume.")
            return
        except Exception as e:
            print(f"  ERROR on {c.get('name') or c['id']}: {e}")
            print("  continuing with next channel; re-run to retry this one")

    print("\nDone." if not args.dry_run else "\nDry run complete.")


if __name__ == "__main__":
    main()
