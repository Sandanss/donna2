"""PHI encryption helpers for read/write compatibility during migration."""

from __future__ import annotations

from copy import deepcopy

from lib.encryption import decrypt, decrypt_json, encrypt, encrypt_json

ENCRYPTED_PLACEHOLDER = "[encrypted]"


def _prefer_text(row: dict, plain_key: str, encrypted_key: str):
    if row.get(encrypted_key):
        return decrypt(row.get(encrypted_key))
    return row.get(plain_key)


def _prefer_json(row: dict, plain_key: str, encrypted_key: str):
    if row.get(encrypted_key):
        return decrypt_json(row.get(encrypted_key))
    return row.get(plain_key)


def _drop(row: dict, *keys: str) -> dict:
    for key in keys:
        row.pop(key, None)
    return row


def decrypt_senior_phi(row: dict | None) -> dict | None:
    if row is None:
        return None
    clean = dict(row)
    clean["family_info"] = _prefer_json(row, "family_info", "family_info_encrypted")
    clean["profile_notes"] = _prefer_text(row, "profile_notes", "profile_notes_encrypted")
    if clean["profile_notes"] is None:
        clean["profile_notes"] = _prefer_text(row, "medical_notes", "medical_notes_encrypted")
    clean["preferred_call_times"] = _prefer_json(row, "preferred_call_times", "preferred_call_times_encrypted")
    clean["additional_info"] = _prefer_text(row, "additional_info", "additional_info_encrypted")
    clean["call_context_snapshot"] = _prefer_json(row, "call_context_snapshot", "call_context_snapshot_encrypted")
    return _drop(
        clean,
        "family_info_encrypted",
        "profile_notes_encrypted",
        "medical_notes",
        "medical_notes_encrypted",
        "preferred_call_times_encrypted",
        "additional_info_encrypted",
        "call_context_snapshot_encrypted",
    )


def encrypt_senior_update(data: dict) -> dict:
    values = dict(data)
    if "familyInfo" in data:
        values["familyInfoEncrypted"] = encrypt_json(data.get("familyInfo"))
        values["familyInfo"] = None
    if "profileNotes" in data or "medicalNotes" in data or "profile_notes" in data or "medical_notes" in data:
        if "profileNotes" in data:
            profile_notes = data.get("profileNotes")
        elif "profile_notes" in data:
            profile_notes = data.get("profile_notes")
        elif "medicalNotes" in data:
            profile_notes = data.get("medicalNotes")
        else:
            profile_notes = data.get("medical_notes")
        values["profileNotesEncrypted"] = encrypt(profile_notes)
        values["profileNotes"] = None
        values.pop("medicalNotes", None)
        values.pop("medicalNotesEncrypted", None)
        values.pop("medical_notes", None)
        values.pop("medical_notes_encrypted", None)
    if "preferredCallTimes" in data:
        values["preferredCallTimesEncrypted"] = encrypt_json(data.get("preferredCallTimes"))
        values["preferredCallTimes"] = None
    if "additionalInfo" in data:
        values["additionalInfoEncrypted"] = encrypt(data.get("additionalInfo"))
        values["additionalInfo"] = None
    return values


def decrypt_reminder_phi(row: dict | None) -> dict | None:
    if row is None:
        return None
    clean = dict(row)
    if "title" in row or "title_encrypted" in row:
        clean["title"] = _prefer_text(row, "title", "title_encrypted")
    if "description" in row or "description_encrypted" in row:
        clean["description"] = _prefer_text(row, "description", "description_encrypted")
    return _drop(clean, "title_encrypted", "description_encrypted")


def encrypt_reminder_title(title: str | None) -> tuple[str, str | None]:
    return ENCRYPTED_PLACEHOLDER, encrypt(title)


def encrypt_reminder_description(description: str | None) -> tuple[None, str | None]:
    return None, encrypt(description)


def decrypt_delivery_phi(row: dict | None) -> dict | None:
    if row is None:
        return None
    clean = dict(row)
    clean["user_response"] = _prefer_text(row, "user_response", "user_response_encrypted")
    return _drop(clean, "user_response_encrypted")


def daily_context_payload(row: dict) -> dict:
    return {
        "topicsDiscussed": row.get("topics_discussed") or row.get("topicsDiscussed") or [],
        "remindersDelivered": row.get("reminders_delivered") or row.get("remindersDelivered") or [],
        "adviceGiven": row.get("advice_given") or row.get("adviceGiven") or [],
        "keyMoments": row.get("key_moments") or row.get("keyMoments") or [],
        "summary": row.get("summary"),
    }


def decrypt_daily_context_phi(row: dict | None) -> dict | None:
    if row is None:
        return None
    clean = dict(row)
    payload = decrypt_json(row["context_encrypted"]) if row.get("context_encrypted") else daily_context_payload(row)
    clean["topics_discussed"] = payload.get("topicsDiscussed") or []
    clean["reminders_delivered"] = payload.get("remindersDelivered") or []
    clean["advice_given"] = payload.get("adviceGiven") or []
    clean["key_moments"] = payload.get("keyMoments") or []
    clean["summary"] = payload.get("summary")
    return _drop(clean, "context_encrypted")


def encrypt_daily_context_payload(data: dict) -> str | None:
    return encrypt_json(daily_context_payload(data))


def decrypt_prospect_phi(row: dict | None) -> dict | None:
    if row is None:
        return None
    clean = dict(row)
    details = decrypt_json(row["details_encrypted"]) if row.get("details_encrypted") else {}
    if isinstance(details, dict):
        clean["learned_name"] = details.get("learned_name") or clean.get("learned_name")
        clean["relationship"] = details.get("relationship") or clean.get("relationship")
        clean["loved_one_name"] = details.get("loved_one_name") or clean.get("loved_one_name")
        clean["caller_context"] = deepcopy(details.get("caller_context") or clean.get("caller_context") or {})
    return _drop(clean, "details_encrypted")


def prospect_details(row: dict | None) -> dict:
    if not row:
        return {
            "learned_name": None,
            "relationship": None,
            "loved_one_name": None,
            "caller_context": {},
        }
    clean = decrypt_prospect_phi(row) or {}
    return {
        "learned_name": clean.get("learned_name"),
        "relationship": clean.get("relationship"),
        "loved_one_name": clean.get("loved_one_name"),
        "caller_context": clean.get("caller_context") or {},
    }
