import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/home.css";
import "./styles/lobby.css";
import "./styles/voice.css";
import "./styles/admin.css";
import "./styles/company.css";
import "./styles/work.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./app/Root.tsx";
import { reloadOnStaleBuild } from "./app/staleBuild.ts";
import { createLibrary } from "./content/library.ts";
import { localDateOf } from "./domain/calendar.ts";
import { HttpAccountApi } from "./storage/account-api.ts";
import { HttpAdminApi } from "./storage/admin-api.ts";
import { HttpCompanyApi } from "./storage/company-api.ts";
import { HttpBillingApi, IS_PRO_ON_SALE } from "./storage/billing-api.ts";
import type { ProSale } from "./ui/ProPanel.tsx";
import { BrowserProgressStore } from "./storage/progress-store.ts";
import { BrowserChangeClock, SyncingProgressStore } from "./storage/syncing-progress-store.ts";

const packs = import.meta.glob<unknown>("./content/packs/*.json", { eager: true, import: "default" });
const library = createLibrary(packs, ({ path, message }) => console.error(`Skipped invalid incident pack ${path}:\n${message}`));
const storage = safeLocalStorage();
const accounts = new HttpAccountApi();
const store = new SyncingProgressStore(new BrowserProgressStore(storage), new BrowserChangeClock(storage), accounts);
// Until Pro goes on sale nothing ever reaches the billing API.
const proSale: ProSale = IS_PRO_ON_SALE ? { status: "open", billing: new HttpBillingApi(), go: (url) => window.location.assign(url) } : { status: "coming-soon" };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = () => localDateOf(new Date(), timeZone);

reloadOnStaleBuild(window, safeSessionStorage() ?? null);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <Root library={library} store={store} sync={store} accounts={accounts} today={today} shareUrl={window.location.origin} proSale={proSale} adminApi={new HttpAdminApi()} companyApi={new HttpCompanyApi()} />
  </StrictMode>,
);

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch (error) {
    if (error instanceof DOMException) return undefined;
    throw error;
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch (error) {
    if (error instanceof DOMException) return undefined;
    throw error;
  }
}
