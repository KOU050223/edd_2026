// consent:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { consentStore, reviewConsent } from "../consent-dialog.js";
import { INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle } from "./helpers.js";
import { INVOKE_SCHEMAS } from "./schemas.js";

export function registerConsentIpc(): void {
  handle(INVOKE_CHANNELS.consentStatus, INVOKE_SCHEMAS["consent:status"], () => {
    const store = consentStore();
    return { granted: store.has(), grantedAt: store.grantedAt() };
  });
  handle(INVOKE_CHANNELS.consentReview, INVOKE_SCHEMAS["consent:review"], async () => {
    await reviewConsent();
    const store = consentStore();
    return { granted: store.has(), grantedAt: store.grantedAt() };
  });
}
