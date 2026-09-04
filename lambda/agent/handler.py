# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Demo agent that talks to Bedrock (Converse API) and calls banking tools
through an AgentCore Gateway MCP endpoint using SigV4 (AWS_IAM inbound auth).

Every tool call, gateway verdict (ALLOW / DENY / THROTTLED / TOOL_ERROR),
model message, and token usage figure is recorded to DynamoDB so the
dashboard can replay the trajectory in near real time.

Two modes:
  - "agent": a real LLM tool-use loop (Bedrock Converse).
  - "burst": scripted rapid-fire tool calls that simulate a runaway agent
    retry loop, used to demonstrate gateway rate limiting deterministically.
    The dashboard labels this traffic as simulated.
"""

import json
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import boto3
import urllib3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

GATEWAY_URL = os.environ["GATEWAY_URL"]
MODEL_ID = os.environ["MODEL_ID"]
TABLE_NAME = os.environ["TABLE_NAME"]
REGION = os.environ.get("AWS_REGION", "us-east-1")

SESSION_HEADER = "x-amzn-bedrock-agentcore-policy-session-id"
MCP_PROTOCOL_VERSION = "2025-03-26"

http = urllib3.PoolManager(timeout=urllib3.Timeout(connect=5.0, read=60.0))
ddb = boto3.resource("dynamodb").Table(TABLE_NAME)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
session = boto3.Session()

SYSTEM_PROMPT = (
    "You are a banking operations agent in a SANDBOX DEMO environment. All "
    "accounts, customers, and money are synthetic test data; no real funds "
    "exist. Follow the user's instructions literally using the available "
    "tools. Call tools one at a time and wait for each result. If a tool "
    "call is denied by policy or throttled, do NOT retry the same call and "
    "do NOT try to work around it: report exactly what was denied and why. "
    "However, if the user's instructions explicitly say what to do after a "
    "denial (for example, obtaining a fresh approval), follow those "
    "instructions. When asked to perform several purchases, make one "
    "purchase_item call per item until one is denied, then stop and "
    "summarize how many succeeded. Keep your answers to one or two short "
    "sentences."
)

# Static mirror of the gateway target tool schema (target name: BankTools).
TOOLS = [
    {
        "name": "BankTools___get_account_balance",
        "description": "Retrieve the current account balance for a customer. Returns the accountId that belongs to the customer.",
        "inputSchema": {
            "type": "object",
            "properties": {"customerId": {"type": "string", "description": "Customer id, e.g. C-1001"}},
            "required": ["customerId"],
        },
    },
    {
        "name": "BankTools___transfer_funds",
        "description": "Transfer funds between two accounts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "fromAccount": {"type": "string"},
                "toAccount": {"type": "string"},
                "amount": {"type": "integer", "description": "Amount in USD"},
            },
            "required": ["fromAccount", "toAccount", "amount"],
        },
    },
    {
        "name": "BankTools___purchase_item",
        "description": "Purchase one item on the corporate account.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "itemId": {"type": "string"},
                "amount": {"type": "integer", "description": "Price in USD"},
            },
            "required": ["itemId", "amount"],
        },
    },
    {
        "name": "BankTools___get_market_news",
        "description": "Get the latest market news for a topic.",
        "inputSchema": {
            "type": "object",
            "properties": {"topic": {"type": "string"}},
            "required": ["topic"],
        },
    },
    {
        "name": "BankTools___read_market_research",
        "description": "Read the latest third-party market research note for a topic. External, unverified content.",
        "inputSchema": {
            "type": "object",
            "properties": {"topic": {"type": "string", "description": "Topic or ticker, e.g. ACME"}},
            "required": ["topic"],
        },
    },
    {
        "name": "BankTools___approve_trade",
        "description": "Request maker-checker approval for a trade (simulated human/compliance approval). Returns an approval record for the exact ticker and quantity.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Ticker symbol, e.g. AMZN"},
                "qty": {"type": "integer", "description": "Number of shares"},
            },
            "required": ["ticker", "qty"],
        },
    },
    {
        "name": "BankTools___execute_trade",
        "description": "Execute a trade for a ticker and quantity.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "Ticker symbol, e.g. AMZN"},
                "qty": {"type": "integer", "description": "Number of shares"},
            },
            "required": ["ticker", "qty"],
        },
    },
]

DENY_PATTERN = re.compile(r"denied|not authorized|unauthorized|access ?denied|forbid", re.I)
THROTTLE_PATTERN = re.compile(r"throttl|rate.?limit|too many requests", re.I)


class EventRecorder:
    def __init__(self, run_id: str, act_id: str):
        self.run_id = run_id
        self.act_id = act_id
        self.seq = 0

    def record(self, kind: str, **fields):
        self.seq += 1
        item = {
            "runId": self.run_id,
            "seq": self.seq,
            "ts": Decimal(str(round(time.time(), 3))),
            "kind": kind,
            "actId": self.act_id,
            "expireAt": int(time.time()) + 24 * 3600,
        }
        for k, v in fields.items():
            if v is None:
                continue
            if isinstance(v, float):
                v = Decimal(str(round(v, 3)))
            if isinstance(v, (dict, list)):
                v = json.dumps(v, default=str)[:4000]
            item[k] = v
        ddb.put_item(Item=item)


def _mcp_url() -> str:
    return GATEWAY_URL if GATEWAY_URL.rstrip("/").endswith("/mcp") else GATEWAY_URL.rstrip("/") + "/mcp"


def call_gateway_tool(session_id: str, tool_name: str, arguments: dict):
    """Signed JSON-RPC tools/call against the gateway MCP endpoint.

    Returns (decision, detail, raw). decision in ALLOW | DENY | THROTTLED | TOOL_ERROR | ERROR.
    """
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }
    )
    url = _mcp_url()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        SESSION_HEADER: session_id,
    }
    request = AWSRequest(method="POST", url=url, data=body, headers=headers)
    credentials = session.get_credentials().get_frozen_credentials()
    SigV4Auth(credentials, "bedrock-agentcore", REGION).add_auth(request)

    started = time.time()
    response = http.request("POST", url, body=body, headers=dict(request.headers))
    latency_ms = int((time.time() - started) * 1000)
    text = response.data.decode("utf-8", errors="replace")

    payload = _parse_jsonrpc(text)

    if response.status == 429:
        return "THROTTLED", _short(payload or text), {"status": response.status, "latencyMs": latency_ms}
    if response.status >= 400:
        detail = _short(payload or text)
        if DENY_PATTERN.search(detail):
            return "DENY", detail, {"status": response.status, "latencyMs": latency_ms}
        if THROTTLE_PATTERN.search(detail):
            return "THROTTLED", detail, {"status": response.status, "latencyMs": latency_ms}
        return "ERROR", detail, {"status": response.status, "latencyMs": latency_ms}

    if payload is None:
        return "ERROR", f"Unparseable gateway response: {text[:300]}", {"status": response.status, "latencyMs": latency_ms}

    if "error" in payload:
        message = json.dumps(payload["error"], default=str)
        if DENY_PATTERN.search(message):
            return "DENY", _short(payload["error"]), {"status": response.status, "latencyMs": latency_ms}
        if THROTTLE_PATTERN.search(message):
            return "THROTTLED", _short(payload["error"]), {"status": response.status, "latencyMs": latency_ms}
        return "ERROR", _short(payload["error"]), {"status": response.status, "latencyMs": latency_ms}

    result = payload.get("result", {})
    content_text = _content_text(result)
    if result.get("isError"):
        if DENY_PATTERN.search(content_text):
            return "DENY", content_text[:600], {"status": response.status, "latencyMs": latency_ms}
        if THROTTLE_PATTERN.search(content_text):
            return "THROTTLED", content_text[:600], {"status": response.status, "latencyMs": latency_ms}
        return "TOOL_ERROR", content_text[:600], {"status": response.status, "latencyMs": latency_ms}
    return "ALLOW", content_text[:600], {"status": response.status, "latencyMs": latency_ms}


def _parse_jsonrpc(text: str):
    text = text.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None
    # SSE framing: take the last data: line.
    data_lines = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
    for candidate in reversed(data_lines):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _content_text(result: dict) -> str:
    parts = []
    for block in result.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    if not parts:
        sc = result.get("structuredContent")
        if sc is not None:
            parts.append(json.dumps(sc, default=str))
    return "\n".join(parts) if parts else json.dumps(result, default=str)


def _short(value) -> str:
    if isinstance(value, str):
        return value[:600]
    return json.dumps(value, default=str)[:600]


def run_agent(recorder: EventRecorder, session_id: str, prompt: str, max_tool_calls: int = 14):
    tool_config = {
        "tools": [
            {
                "toolSpec": {
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": {"json": t["inputSchema"]},
                }
            }
            for t in TOOLS
        ]
    }
    messages = [{"role": "user", "content": [{"text": prompt}]}]
    recorder.record("user_prompt", text=prompt)

    tool_calls = 0
    for _turn in range(10):
        response = bedrock.converse(
            modelId=MODEL_ID,
            system=[{"text": SYSTEM_PROMPT}],
            messages=messages,
            toolConfig=tool_config,
            inferenceConfig={"maxTokens": 1024, "temperature": 0.2},
        )
        usage = response.get("usage", {})
        recorder.record(
            "model_usage",
            inputTokens=usage.get("inputTokens", 0),
            outputTokens=usage.get("outputTokens", 0),
        )
        output_message = response["output"]["message"]
        messages.append(output_message)

        for block in output_message.get("content", []):
            if "text" in block and block["text"].strip():
                recorder.record("model_text", text=block["text"][:2000])

        if response.get("stopReason") != "tool_use":
            break

        tool_results = []
        for block in output_message.get("content", []):
            if "toolUse" not in block:
                continue
            tool_use = block["toolUse"]
            tool_name, arguments = tool_use["name"], tool_use.get("input", {})
            tool_calls += 1

            recorder.record("tool_call", tool=tool_name, args=arguments)
            if tool_calls > max_tool_calls:
                decision, detail, meta = "ERROR", "Demo tool-call budget exhausted.", {}
            else:
                decision, detail, meta = call_gateway_tool(session_id, tool_name, arguments)
            recorder.record(
                "verdict",
                tool=tool_name,
                args=arguments,
                decision=decision,
                detail=detail,
                latencyMs=meta.get("latencyMs"),
                httpStatus=meta.get("status"),
            )

            if decision == "ALLOW":
                tool_results.append(
                    {
                        "toolResult": {
                            "toolUseId": tool_use["toolUseId"],
                            "content": [{"text": detail or "OK"}],
                        }
                    }
                )
            else:
                tool_results.append(
                    {
                        "toolResult": {
                            "toolUseId": tool_use["toolUseId"],
                            "content": [{"text": f"[{decision}] {detail}"}],
                            "status": "error",
                        }
                    }
                )
            # Give the policy engine a moment to record the response event
            # before any dependent call (see "Sequencing actions that depend
            # on a prior response" in the AgentCore docs).
            time.sleep(0.4)

        messages.append({"role": "user", "content": tool_results})


def run_burst(recorder: EventRecorder, session_id: str, tool_name: str, count: int, arguments: dict):
    """Simulated runaway retry loop: concurrent calls against one tool.

    Gateway rate limit enforcement is distributed, so it is concurrency that
    trips it visibly; a slow sequential loop can stay under the effective
    limit. The dashboard labels this traffic as simulated.
    """
    recorder.record(
        "burst_started",
        text=f"Simulated runaway loop: {count} concurrent calls to {tool_name}",
        tool=tool_name,
    )
    # Each call gets its own policy session: AgentCore allows at most one
    # concurrent authorization request per session, and the rate limit being
    # demonstrated here dimensions on toolName, not on the session.
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(
            pool.map(
                lambda i: call_gateway_tool(f"{session_id}-{i}", tool_name, arguments),
                range(count),
            )
        )
    for decision, detail, meta in results:
        recorder.record("tool_call", tool=tool_name, args=arguments, simulated=True)
        recorder.record(
            "verdict",
            tool=tool_name,
            args=arguments,
            decision=decision,
            detail=detail,
            latencyMs=meta.get("latencyMs"),
            httpStatus=meta.get("status"),
            simulated=True,
        )


def lambda_handler(event, _context):
    run_id = event["runId"]
    act_id = event.get("actId", "unknown")
    mode = event.get("mode", "agent")
    session_id = event.get("sessionId") or f"dg-{uuid.uuid4()}"

    recorder = EventRecorder(run_id, act_id)
    recorder.record("run_started", mode=mode, sessionId=session_id)
    try:
        if mode == "burst":
            run_burst(
                recorder,
                session_id,
                event.get("tool", "BankTools___get_market_news"),
                int(event.get("count", 15)),
                event.get("arguments", {"topic": "tech"}),
            )
        else:
            run_agent(recorder, session_id, event["prompt"])
        recorder.record("run_finished")
    except Exception as exc:  # noqa: BLE001 - surface everything to the dashboard
        recorder.record("run_error", detail=str(exc)[:1000])
        raise
    return {"runId": run_id, "events": recorder.seq}
