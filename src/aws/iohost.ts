import type { IIoHost, IoMessage, IoRequest } from "@aws-cdk/toolkit-lib";
import { conceptOf } from "./concepts.js";

/** toolkit-lib のメッセージを Flareon の概念に畳んだ進捗イベント。生の CFN イベントは表に出さない。 */
export type ProgressEvent =
  | { type: "assets" }
  | { type: "stack-start"; stack: string }
  | { type: "stack-end"; stack: string }
  | { type: "resource"; stack: string; concept: string; status: string; reason?: string }
  | { type: "error"; message: string };

interface StackActivityData {
  event?: {
    StackName?: string;
    ResourceStatus?: string;
    ResourceStatusReason?: string;
  };
  metadata?: { constructPath?: string };
}

/** 非対話。確認要求（IAM 変更の承認・destroy 確認）は自動承認する（CLI 側で事前確認済みの前提）。 */
const AUTO_APPROVE = new Set(["CDK_TOOLKIT_I5060", "CDK_TOOLKIT_I7010", "CDK_TOOLKIT_I5050"]);

export class FlareonIoHost implements IIoHost {
  private assetsReported = false;

  constructor(private readonly emit: (e: ProgressEvent) => void) {}

  async notify(msg: IoMessage<unknown>): Promise<void> {
    const data = msg.data as Record<string, unknown> | undefined;
    switch (msg.code) {
      case "CDK_TOOLKIT_I5210":
      case "CDK_TOOLKIT_I5220":
        if (!this.assetsReported) {
          this.assetsReported = true;
          this.emit({ type: "assets" });
        }
        return;
      case "CDK_TOOLKIT_I5501":
        this.emit({ type: "stack-start", stack: String(data?.stackName ?? "") });
        return;
      case "CDK_TOOLKIT_I5503":
        this.emit({ type: "stack-end", stack: String(data?.stackName ?? "") });
        return;
      case "CDK_TOOLKIT_I5502": {
        const a = data as StackActivityData | undefined;
        const path = a?.metadata?.constructPath;
        const concept = path ? conceptOf(path) : undefined;
        const status = a?.event?.ResourceStatus;
        if (!concept || !status) return;
        const e: ProgressEvent = {
          type: "resource",
          stack: a?.event?.StackName ?? "",
          concept,
          status,
        };
        if (status.endsWith("_FAILED") && a?.event?.ResourceStatusReason) {
          e.reason = a.event.ResourceStatusReason;
        }
        this.emit(e);
        return;
      }
    }
    if (msg.level === "error") this.emit({ type: "error", message: msg.message });
  }

  async requestResponse<T>(msg: IoRequest<unknown, T>): Promise<T> {
    if (AUTO_APPROVE.has(msg.code)) return true as T;
    return msg.defaultResponse;
  }
}
