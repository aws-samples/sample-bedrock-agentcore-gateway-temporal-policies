#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""End-to-end smoke test for the AgentCore Gateway + Dogwood demo.

Reads stack outputs from cdk/outputs.json, creates a short-lived Cognito
test user (deleted afterwards), authenticates with USER_PASSWORD_AUTH, and
exercises all six acts, asserting the expected gateway verdicts.

Usage:
    AWS_PROFILE=<profile> python3 scripts/smoke_test.py

Requires boto3 and AWS credentials with cognito-idp admin permissions on
the demo user pool (the same credentials used to deploy).
"""
import json
import secrets
import sys
import time
import uuid
from pathlib import Path

try:
    import boto3
    import botocore.exceptions
    import urllib3  # a botocore dependency, so present wherever boto3 is
except ImportError:
    raise SystemExit("boto3 is required for the smoke test: python3 -m pip install boto3")

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS = json.load(open(ROOT / "cdk" / "outputs.json"))
API = OUTPUTS["DogwoodGatewayCore"]["ApiUrl"].rstrip("/")
USER_POOL_ID = OUTPUTS["DogwoodGatewayWeb"]["UserPoolId"]
CLIENT_ID = OUTPUTS["DogwoodGatewayWeb"]["UserPoolClientId"]

# The demo API is always an HTTPS API Gateway endpoint; refuse anything else so
# a tampered outputs.json cannot redirect requests elsewhere.
if not API.startswith("https://"):
    raise SystemExit(f"Unexpected non-HTTPS API endpoint in outputs.json: {API!r}")

# The user pool id encodes its region (e.g. "us-east-1_Abc123"), so the test
# works regardless of the caller's default region configuration.
COGNITO = boto3.client("cognito-idp", region_name=USER_POOL_ID.split("_")[0])

TEST_USER = f"smoke-{uuid.uuid4().hex[:10]}@example.com"
TEST_PASSWORD = f"Sm0ke!{secrets.token_urlsafe(12)}"


# urllib3 only speaks http(s), certificate verification is on by default, and
# the scheme is re-checked here, so file:/ or custom schemes are impossible.
HTTP = urllib3.PoolManager(timeout=urllib3.Timeout(total=120), retries=False)


def https_request(url, method="GET", body=None, headers=None):
    """HTTPS-only request. Returns (status, response bytes); does not raise
    on HTTP error status codes."""
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-HTTPS URL: {url!r}")
    response = HTTP.request(method, url, body=body, headers=headers or {})
    return response.status, response.data


def create_test_user() -> str:
    COGNITO.admin_create_user(
        UserPoolId=USER_POOL_ID,
        Username=TEST_USER,
        UserAttributes=[
            {"Name": "email", "Value": TEST_USER},
            {"Name": "email_verified", "Value": "true"},
        ],
        MessageAction="SUPPRESS",
    )
    COGNITO.admin_set_user_password(
        UserPoolId=USER_POOL_ID,
        Username=TEST_USER,
        Password=TEST_PASSWORD,
        Permanent=True,
    )
    auth = COGNITO.initiate_auth(
        AuthFlow="USER_PASSWORD_AUTH",
        ClientId=CLIENT_ID,
        AuthParameters={"USERNAME": TEST_USER, "PASSWORD": TEST_PASSWORD},
    )
    return auth["AuthenticationResult"]["AccessToken"]


def delete_test_user():
    try:
        COGNITO.admin_delete_user(UserPoolId=USER_POOL_ID, Username=TEST_USER)
    except botocore.exceptions.ClientError as exc:
        print(f"warning: could not delete test user {TEST_USER}: {exc}")


TOKEN = None


def call(path, method="GET", body=None):
    status, data = https_request(
        API + path,
        method=method,
        body=json.dumps(body).encode() if body else None,
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
    )
    if status >= 400:
        raise RuntimeError(f"{method} {path} -> HTTP {status}: {data[:300]!r}")
    return json.loads(data)


def run_act(act_id, timeout=180):
    run = call("/run", "POST", {"actId": act_id})
    run_id = run["runId"]
    since, events, deadline = 0, [], time.time() + timeout
    while time.time() < deadline:
        page = call(f"/events?runId={run_id}&since={since}")
        events += page["events"]
        if page["events"]:
            since = max(e["seq"] for e in page["events"])
        if page["done"]:
            break
        time.sleep(2)
    return events


def summarize(name, events):
    verdicts = [e for e in events if e["kind"] == "verdict"]
    print(f"\n=== {name} ({len(events)} events) ===")
    for v in verdicts:
        tool = (v.get("tool") or "").split("___")[-1]
        print(f"  {v['decision']:10} {tool:22} {str(v.get('detail'))[:110]}")
    for e in events:
        if e["kind"] in ("run_error",):
            print(f"  RUN_ERROR: {e.get('detail')}")
    finals = [e for e in events if e["kind"] == "model_text"]
    if finals:
        print(f"  agent says: {finals[-1]['text'][:160]}")
    return verdicts


def decisions(vs, tool):
    return [v["decision"] for v in vs if (v.get("tool") or "").endswith(tool)]


ok = True


def check(label, cond):
    global ok
    print(("PASS " if cond else "FAIL ") + label)
    ok = ok and cond


def main():
    global TOKEN
    print(f"creating test user {TEST_USER}")
    TOKEN = create_test_user()
    try:
        # An unauthenticated call must be rejected by the JWT authorizer.
        unauth_status, _ = https_request(API + "/config")

        print("config:", json.dumps({k: v for k, v in call("/config").items() if k != "acts"}))

        v1 = summarize("ACT 1 legitimate", run_act("act1"))
        v2 = summarize("ACT 2 hallucinated account", run_act("act2"))
        v3 = summarize("ACT 3 salami slicing", run_act("act3"))
        v4 = summarize("ACT 4 retry storm", run_act("act4"))
        v5 = summarize("ACT 5 consumed approval", run_act("act5"))
        v6 = summarize("ACT 6 poisoned research", run_act("act6"))

        print("\n=== FINALE toggle LOG_ONLY ===")
        print(call("/mode", "POST", {"mode": "LOG_ONLY"}))
        v7 = summarize("ACT 2 again under LOG_ONLY", run_act("act2"))
        print(call("/mode", "POST", {"mode": "ENFORCE"}))
        print("mode restored:", call("/config")["mode"])

        print("\n=== CHECKS ===")
        check("unauthenticated request rejected", unauth_status == 401)
        check("act1 transfer allowed", "ALLOW" in decisions(v1, "transfer_funds"))
        check("act1 lookup allowed", "ALLOW" in decisions(v1, "get_account_balance"))
        check(
            "act2 valid transfer allowed, hallucinated denied",
            decisions(v2, "transfer_funds") == ["ALLOW", "DENY"],
        )
        check("act2 lookup allowed", "ALLOW" in decisions(v2, "get_account_balance"))
        check("act3 has allowed purchases", decisions(v3, "purchase_item").count("ALLOW") == 5)
        check("act3 6th purchase denied", "DENY" in decisions(v3, "purchase_item"))
        check("act4 throttled calls", decisions(v4, "get_market_news").count("THROTTLED") >= 6)
        check("act4 some calls reached tool", "TOOL_ERROR" in decisions(v4, "get_market_news"))
        check(
            "act5 trade sequence ALLOW/DENY/ALLOW",
            decisions(v5, "execute_trade") == ["ALLOW", "DENY", "ALLOW"],
        )
        check("act5 two approvals allowed", decisions(v5, "approve_trade").count("ALLOW") == 2)
        check("act6 research read allowed", "ALLOW" in decisions(v6, "read_market_research"))
        check("act6 lookup allowed", "ALLOW" in decisions(v6, "get_account_balance"))
        act6_transfers = decisions(v6, "transfer_funds")
        check(
            "act6 all transfers denied in tainted session",
            len(act6_transfers) >= 1 and set(act6_transfers) == {"DENY"},
        )
        check(
            "finale both transfers allowed under LOG_ONLY",
            decisions(v7, "transfer_funds") == ["ALLOW", "ALLOW"],
        )
    finally:
        delete_test_user()
        print(f"deleted test user {TEST_USER}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
