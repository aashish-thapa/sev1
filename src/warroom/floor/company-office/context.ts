import { createContext, useContext } from "react";
import { FULL_OFFICE, type CompanyLayout, type OfficePlan } from "./plan.ts";

/** The office being drawn: the whole building, or only what a company bought. */
export const OfficePlanContext = createContext<OfficePlan>(FULL_OFFICE);

export function useOfficePlan(): OfficePlan {
  return useContext(OfficePlanContext);
}

/** The company whose office this room is, and who you are on its books; null in job mode and ordinary team rooms. */
export type CompanyOfficeVisit = { readonly company: CompanyLayout; readonly me: string | null };

export const CompanyOfficeContext = createContext<CompanyOfficeVisit | null>(null);
