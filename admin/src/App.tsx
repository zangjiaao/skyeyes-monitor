import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { MouseEvent } from "react";
import { DataPage } from "./pages/DataPage";
import { EmailLogPage } from "./pages/EmailLogPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatusPage } from "./pages/StatusPage";
import { TargetsPage } from "./pages/TargetsPage";

const LINKS = [
  { href: "/status", label: "系统状态" },
  { href: "/targets", label: "监测目标" },
  { href: "/settings", label: "配置" },
  { href: "/email-log", label: "发信记录" },
  { href: "/data", label: "数据" },
];

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const go = (href: string) => (event: MouseEvent) => {
    event.preventDefault();
    navigate(href);
  };

  return (
    <AppShell
      height="fill"
      contentPadding={4}
      sideNav={(
        <SideNav
          header={<SideNavHeading heading="SkyEyes" subheading="监测后台" />}
        >
          <SideNavSection title="管理">
            {LINKS.map((link) => (
              <SideNavItem
                key={link.href}
                label={link.label}
                href={link.href}
                isSelected={location.pathname === link.href}
                onClick={go(link.href)}
              />
            ))}
          </SideNavSection>
        </SideNav>
      )}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/status" replace />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/targets" element={<TargetsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/email-log" element={<EmailLogPage />} />
        <Route path="/data" element={<DataPage />} />
        <Route path="*" element={<Navigate to="/status" replace />} />
      </Routes>
    </AppShell>
  );
}
