"""
Meta Marketing API helpers. Based on docs/meta_ads_api.txt.
All functions require a valid access_token (from Meta / Facebook Login).
"""
import os
import requests

BASE_URL = "https://graph.facebook.com/v23.0"

# Optional: read default token from env so main can call without passing token each time
def _token():
    return os.environ.get("META_ACCESS_TOKEN", "")


def _raise_for_graph_error(response: requests.Response) -> None:
    """Raise an error without including the request URL, which may contain access_token."""
    if response.status_code < 400:
        return
    body = response.text[:2000]
    raise RuntimeError(f"Graph API request failed: status={response.status_code} body={body}")


def _get(access_token: str, path: str, params: dict | None = None) -> dict:
    """GET a Graph API node. path is e.g. 'me/adaccounts' or 'act_123/campaigns' (no leading slash)."""
    url = f"{BASE_URL}/{path}" if not path.startswith("http") else path
    p = dict(access_token=access_token)
    if params:
        p.update(params)
    r = requests.get(url, params=p, timeout=30)
    _raise_for_graph_error(r)
    return r.json()


# --- 0: Ad accounts (list and optional detail) ---

def get_ad_accounts(access_token: str | None = None, limit: int = 500) -> list[dict]:
    """
    If user did not specify an account id, provide a list of available ids.
    GET /v23.0/me/adaccounts?limit=500
    Returns list of {"account_id", "id"}.
    """
    token = access_token or _token()
    data = _get(token, "me/adaccounts", {"limit": limit})
    return data.get("data", [])


def get_ad_account_detail(access_token: str | None = None, account_id: str = "") -> dict:
    """
    Account detail: id, name, account_status, currency, timezone_name, amount_spent.
    GET /v23.0/act_{account_id}?fields=id,name,account_status,currency,timezone_name,amount_spent
    account_id can be with or without 'act_' prefix.
    """
    token = access_token or _token()
    act = account_id if account_id.startswith("act_") else f"act_{account_id}"
    return _get(token, act, {"fields": "id,name,account_status,currency,timezone_name,amount_spent"})


def get_ad_account_name(access_token: str | None = None, account_id: str = "") -> dict:
    """
    Minimal ad account node for display.
    GET /v23.0/act_{account_id}?fields=id,name
    account_id can be with or without 'act_' prefix.
    """
    token = access_token or _token()
    act = account_id if account_id.startswith("act_") else f"act_{account_id}"
    return _get(token, act, {"fields": "id,name"})


# --- 1: Campaigns ---

def get_campaigns(access_token: str | None = None, account_id: str = "") -> list[dict]:
    """
    Get all campaign_id for an ad account.
    GET /v23.0/act_{id}/campaigns?fields=id,name,status,objective,created_time,updated_time
    Returns list of campaigns; follows paging.
    """
    token = access_token or _token()
    act = account_id if account_id.startswith("act_") else f"act_{account_id}"
    path = f"{act}/campaigns"
    params = {"fields": "id,name,status,objective,created_time,updated_time", "limit": 500}
    out = []
    while path:
        if path.startswith("http"):
            # Full URL from paging.next (already has token in doc example)
            r = requests.get(path, timeout=30)
            _raise_for_graph_error(r)
            data = r.json()
        else:
            data = _get(token, path, params)
        out.extend(data.get("data", []))
        paging = data.get("paging", {})
        path = paging.get("next", "") or ""
        params = None  # next URL is complete
    return out


# --- 2: Ads of an account ---

def get_ads(access_token: str | None = None, account_id: str = "", limit: int = 1000) -> list[dict]:
    """
    Get all ads of an ad account.
    GET /v23.0/act_{account_id}/ads?fields=id,name,status,created_time,updated_time,adset_id,campaign_id,creative&limit=1000
    Returns list of ads (each has creative.id for step 3).
    """
    token = access_token or _token()
    act = account_id if account_id.startswith("act_") else f"act_{account_id}"
    path = f"{act}/ads"
    params = {
        "fields": "id,name,status,created_time,updated_time,adset_id,campaign_id,creative",
        "limit": min(limit, 500),
    }
    out = []
    while path and len(out) < limit:
        if path.startswith("http"):
            r = requests.get(path, timeout=30)
            _raise_for_graph_error(r)
            data = r.json()
        else:
            data = _get(token, path, params)
        out.extend(data.get("data", []))
        paging = data.get("paging", {})
        path = paging.get("next", "") or ""
        params = None
    return out[:limit]


# Nested creative fields for single-call fetch (docs/meta_ads_api_1_call_per_adaccount.txt)
_ADS_WITH_CREATIVES_FIELDS = (
    "id,name,created_time,updated_time,effective_status,"
    "creative{id,name,body,object_story_spec,asset_feed_spec}"
)


def get_active_ads_with_creatives(
    access_token: str | None = None,
    account_id: str = "",
    max_ads: int | None = None,
    page_limit: int = 500,
) -> list[dict]:
    """
    Active ads with nested creative text fields in one paginated flow per ad account.
    GET /v23.0/act_{id}/ads?fields=...&effective_status=['ACTIVE']&limit=...
    """
    token = access_token or _token()
    act = account_id if account_id.startswith("act_") else f"act_{account_id}"
    path = f"{act}/ads"
    params = {
        "fields": _ADS_WITH_CREATIVES_FIELDS,
        "effective_status": "['ACTIVE']",
        "limit": min(page_limit, 500),
    }
    out: list[dict] = []
    while path:
        if max_ads is not None and len(out) >= max_ads:
            break
        if path.startswith("http"):
            r = requests.get(path, timeout=30)
            _raise_for_graph_error(r)
            data = r.json()
        else:
            data = _get(token, path, params)
        batch = data.get("data", [])
        if max_ads is not None:
            remaining = max_ads - len(out)
            batch = batch[:remaining]
        out.extend(batch)
        paging = data.get("paging", {})
        path = paging.get("next", "") or ""
        params = None
    return out


# --- 3: Creative detail ---

def get_creative(access_token: str | None = None, creative_id: str = "") -> dict:
    """
    Get ad creative detail aligned with get_active_ads_with_creatives nested fields.
    GET /v23.0/{creative_id}?fields=id,name,body,object_story_spec,asset_feed_spec
    """
    token = access_token or _token()
    return _get(token, creative_id, {"fields": "id,name,body,object_story_spec,asset_feed_spec"})


# --- 4: Video permalink and preferred thumbnail ---

def get_video_info(access_token: str | None = None, video_id: str = "") -> dict:
    """
    For video posts: get permalink_url and thumbnails.
    GET /v23.0/{video_id}?fields=permalink_url,thumbnails
    Returns dict with permalink_url and thumbnails.data; pick thumbnail where is_preferred is true.
    """
    token = access_token or _token()
    return _get(token, video_id, {"fields": "permalink_url,thumbnails"})


def get_preferred_thumbnail(thumbnails_data: list[dict]) -> str | None:
    """From get_video_info()['thumbnails']['data'], return uri of the preferred thumbnail, or first."""
    if not thumbnails_data:
        return None
    for t in thumbnails_data:
        if t.get("is_preferred"):
            return t.get("uri")
    return thumbnails_data[0].get("uri")
