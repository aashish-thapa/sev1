import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tokens.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { createLibrary } from "./content/library.ts";
import { localDateOf } from "./domain/calendar.ts";
import { BrowserProgressStore } from "./storage/progress-store.ts";

const packs = import.meta.glob<unknown>("./content/packs/*.json", { eager: true, import: "default" });
const library = createLibrary(packs, ({ path, message }) => console.error(`Skipped invalid incident pack ${path}:\n${message}`));
const store = new BrowserProgressStore(safeLocalStorage());
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = () => localDateOf(new Date(), timeZone);

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App library={library} store={store} today={today} shareUrl={window.location.origin} />
  </StrictMode>,
);

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch (error) {
    if (error instanceof DOMException) return undefined;
    throw error;
  }
}
