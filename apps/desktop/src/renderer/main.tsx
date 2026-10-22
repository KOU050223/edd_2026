// renderer のエントリポイント。画面の構成は App.tsx 以下へ分け、
// ここでは StrictMode の下に描くだけにする（Issue #279 ステップ 4b）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const container = document.querySelector("#root");
if (container === null) throw new Error("#root が見つかりません");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
