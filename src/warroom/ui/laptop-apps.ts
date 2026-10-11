import { createContext, useContext, type ReactNode } from "react";

/** An app on the laptop besides the shell, supplied by wherever you are (your company's tools, at its office). */
export type LaptopApp = { readonly id: string; readonly title: string; readonly render: () => ReactNode };

export const LaptopAppsContext = createContext<readonly LaptopApp[]>([]);

export function useLaptopApps(): readonly LaptopApp[] {
  return useContext(LaptopAppsContext);
}
