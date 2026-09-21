import { expect, it } from "vitest";

import { AuthOperationState } from "./auth-operation.js";

it("認証世代を進めると、進行中の処理を古い処理として判定する", () => {
  const state = new AuthOperationState();
  const generation = state.current();

  state.begin();

  expect(state.isCurrent(generation)).toBe(false);
});

it("ログイン中の状態を保持し、完了時に解除する", () => {
  const state = new AuthOperationState();

  state.beginLogin();
  expect(state.isLoginInProgress()).toBe(true);

  state.finishLogin();
  expect(state.isLoginInProgress()).toBe(false);
});
