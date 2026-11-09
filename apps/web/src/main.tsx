import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "./router";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("缺少页面根节点 #root");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
