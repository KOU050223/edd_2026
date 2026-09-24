import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

/**
 * 設定の共通枠。「一般 / 使用状況 / プラン / データ」を切り替える（Issue #165）。
 *
 * 切り替えはリンクで書く。どの画面を開いているかが URL に載るので、
 * 再読み込みや共有で開いていた画面が変わらない。
 */
function SettingsLayout() {
  return (
    <div className="settings">
      <h1>設定</h1>
      <nav className="settings-nav" aria-label="設定の項目">
        {/* `/settings` は配下の全画面の接頭辞なので、完全一致でだけ選択中にする。 */}
        <Link
          to="/settings"
          activeOptions={{ exact: true }}
          activeProps={{ className: "selected" }}
        >
          一般
        </Link>
        <Link to="/settings/usage" activeProps={{ className: "selected" }}>
          使用状況
        </Link>
        <Link to="/settings/billing" activeProps={{ className: "selected" }}>
          プラン
        </Link>
        <Link to="/settings/data" activeProps={{ className: "selected" }}>
          データ
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/_framed/settings")({
  component: SettingsLayout,
});
