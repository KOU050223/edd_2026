import { describe, expect, it, vi } from "vitest";

import { readAnswerStream } from "./ask.js";

const encoder = new TextEncoder();

const sse = (text: string) =>
  encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`);

/** 外からチャンクを差せて cancel 呼び出しを観測できる ReadableStream。 */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    stream,
    cancel,
    push: (chunk: Uint8Array) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

describe("readAnswerStream", () => {
  it("emits every delta to onDelta when the stream completes", async () => {
    const { stream, push, close } = controllableBody();
    const deltas: string[] = [];
    const done = readAnswerStream(new Response(stream), (d) => deltas.push(d));
    push(sse("こん"));
    push(sse("にちは"));
    close();
    await done;
    expect(deltas).toEqual(["こん", "にちは"]);
  });

  it("cancels the reader and rejects with the abort reason when aborted mid-stream", async () => {
    const { stream, cancel, push } = controllableBody();
    const controller = new AbortController();
    const deltas: string[] = [];
    const done = readAnswerStream(new Response(stream), (d) => deltas.push(d), controller.signal);
    push(sse("途中まで"));
    // 最初のチャンクが捌けるのを待ってから中断する。
    await vi.waitFor(() => expect(deltas).toEqual(["途中まで"]));

    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(done).rejects.toBe(reason);
    // 上流の読み取りを切るため reader.cancel() が届いていること。
    expect(cancel).toHaveBeenCalled();
  });

  it("does not emit deltas that arrive after the abort", async () => {
    const { stream, cancel, push } = controllableBody();
    const controller = new AbortController();
    const deltas: string[] = [];
    const done = readAnswerStream(new Response(stream), (d) => deltas.push(d), controller.signal);
    push(sse("最初"));
    await vi.waitFor(() => expect(deltas).toEqual(["最初"]));

    controller.abort();
    await expect(done).rejects.toBeTruthy();
    expect(cancel).toHaveBeenCalled();
    // 中断後に届いても画面へは流れない（RULE-005）。cancel 済みのストリームへの
    // enqueue は捨てられる。
    expect(() => push(sse("あとから"))).toThrow();
    expect(deltas).toEqual(["最初"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { stream, cancel } = controllableBody();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readAnswerStream(new Response(stream), () => undefined, controller.signal),
    ).rejects.toBeTruthy();
    expect(cancel).toHaveBeenCalled();
  });

  it("lets an abort win over a hanging error-body read", async () => {
    const { stream } = controllableBody(); // 書き込まずに開いたまま → text() が終わらない
    const controller = new AbortController();
    const done = readAnswerStream(
      new Response(stream, { status: 500 }),
      () => undefined,
      controller.signal,
    );
    controller.abort();
    await expect(done).rejects.toBeTruthy();
  });

  it("surfaces the server error body when the response is not ok", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"error":"鍵が未設定です"}'));
        c.close();
      },
    });
    await expect(
      readAnswerStream(new Response(body, { status: 400 }), () => undefined),
    ).rejects.toThrow("鍵が未設定です");
  });
});
