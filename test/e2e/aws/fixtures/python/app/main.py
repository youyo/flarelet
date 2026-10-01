"""実 AWS E2E 用のアプリ。Flarelet のバインディング（DB / Storage / AI / secrets）と認証 identity を確認する。"""

import hashlib
import json
import os

import boto3
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

app = FastAPI()


def _table():
    return boto3.resource("dynamodb").Table(os.environ["FLARELET_DATABASE_MAIN_TABLE"])


def _bucket():
    return os.environ["FLARELET_STORAGE_FILES_BUCKET"]


@app.get("/")
def index(request: Request):
    return {
        "app": "python",
        "version": os.environ.get("FLARELET_VERSION"),
        "user": request.headers.get("x-flarelet-user-email"),
    }


@app.get("/whoami")
def whoami(request: Request):
    return {
        "sub": request.headers.get("x-flarelet-user-sub"),
        "email": request.headers.get("x-flarelet-user-email"),
        "email_verified": request.headers.get("x-flarelet-user-email-verified"),
        "mode": request.headers.get("x-flarelet-auth-mode"),
        "function": os.environ.get("AWS_LAMBDA_FUNCTION_NAME"),
        "version": os.environ.get("FLARELET_VERSION"),
    }


@app.put("/db/{key}")
async def db_put(key: str, request: Request):
    body = await request.json()
    _table().put_item(Item={"pk": "e2e", "sk": key, "value": body["value"]})
    return {"ok": True, "table": os.environ["FLARELET_DATABASE_MAIN_TABLE"]}


@app.get("/db/{key}")
def db_get(key: str):
    item = _table().get_item(Key={"pk": "e2e", "sk": key}).get("Item")
    return {"value": item["value"] if item else None, "table": os.environ["FLARELET_DATABASE_MAIN_TABLE"]}


@app.put("/files/{key}")
async def file_put(key: str, request: Request):
    boto3.client("s3").put_object(Bucket=_bucket(), Key=key, Body=await request.body())
    return {"ok": True}


@app.get("/files/{key}", response_class=PlainTextResponse)
def file_get(key: str):
    return boto3.client("s3").get_object(Bucket=_bucket(), Key=key)["Body"].read().decode()


@app.post("/ai")
def ai():
    res = boto3.client("bedrock-runtime").invoke_model(
        modelId=os.environ["FLARELET_AI_HAIKU_MODEL_ID"],
        body=json.dumps(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply with the single word: pong"}],
            }
        ),
    )
    out = json.loads(res["body"].read())
    return {"model": os.environ["FLARELET_AI_HAIKU_MODEL_ID"], "text": out["content"][0]["text"]}


@app.get("/secret")
def secret():
    # 値そのものは返さない（ログに残さないため）。ハッシュで照合する。
    v = os.environ.get("E2E_SECRET")
    return {"present": v is not None, "sha256": hashlib.sha256(v.encode()).hexdigest() if v else None}
