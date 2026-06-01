import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./views/App";
import { LandingPage } from "./views/LandingPage";
import { OperatorDashboard } from "./views/OperatorDashboard";
import "./styles.css";

const path = window.location.pathname;
const Root =
  path.startsWith("/operator") ? OperatorDashboard :
  path.startsWith("/dashboard") || path.startsWith("/auth") ? App :
  LandingPage;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
