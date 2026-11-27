// 認証付き API 呼び出しに渡す依存の組み立て（Issue #279 ステップ 3 で index.ts から分離）。
import { appState } from "./app-state.js";
import type { AuthedApiDeps } from "./api-request.js";
import { getAccessToken } from "./auth/index.js";

export function apiDeps(): AuthedApiDeps {
  return {
    baseUrl: `${appState.settings.apiBaseUrl.replace(/\/$/, "")}/v1`,
    getAccessToken,
    fetch,
  };
}
