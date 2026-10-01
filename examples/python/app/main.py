"""FastAPI のサンプル。Flareon が環境変数でバインディングを渡す。"""

import os

import boto3
from fastapi import FastAPI, Request

app = FastAPI()
dynamodb = boto3.resource("dynamodb")


def table():
    return dynamodb.Table(os.environ["FLAREON_DATABASE_NOTES_TABLE"])


@app.get("/")
def index(request: Request):
    return {
        "user": request.headers.get("x-flareon-user-email"),
        "bucket": os.environ.get("FLAREON_STORAGE_ATTACHMENTS_BUCKET"),
        "model": os.environ.get("FLAREON_AI_SONNET_MODEL_ID"),
        "has_api_key": "EXTERNAL_API_KEY" in os.environ,
    }


@app.put("/notes/{note_id}")
def put_note(note_id: str, body: dict):
    table().put_item(Item={"pk": "note", "sk": note_id, **body})
    return {"ok": True}


@app.get("/notes/{note_id}")
def get_note(note_id: str):
    return table().get_item(Key={"pk": "note", "sk": note_id}).get("Item")
