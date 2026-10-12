import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Theme } from "@astryxdesign/core/theme";
import "@astryxdesign/core/reset.css";
import { defaultThemeSlug, themes } from "./astryx-themes";
import "./index.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("缺少根节点");

createRoot(root).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Theme>
  </StrictMode>,
);
