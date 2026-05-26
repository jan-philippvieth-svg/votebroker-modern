import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./views/App";
import { OperatorDashboard } from "./views/OperatorDashboard";
import "./styles.css";

const Root = window.location.pathname.startsWith("/operator") ? OperatorDashboard : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
