import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/styles/global.css";
// Monaco is NOT imported here — it ships in the lazy EditorPane chunk so the
// shell paints before the heavy editor bundle loads (spec 2.7 cold-start).

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
