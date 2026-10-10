import { createContext, useCallback, useContext, useState } from "react";
import { categoryById } from "../../../domain/company/catalog.ts";
import type { CompanyBook } from "../../../domain/company/rules.ts";
import type { CompanyApi, CompanyOutcome } from "../../../storage/company-api.ts";
import type { Company } from "../../../storage/company-protocol.ts";
import { companyErrorText } from "../errors.ts";

/** The company as seen from a member's desk: what the laptop's company apps read and act on. */
export type CompanyDesk = {
  readonly api: CompanyApi;
  readonly company: Company;
  readonly username: string | null;
  /** Re-reads the company after something changed it. */
  readonly refresh: () => void;
};

export const CompanyDeskContext = createContext<CompanyDesk | null>(null);

/** Who you are at the company and the book the rules check against (the server still decides). */
export function useDesk(desk: CompanyDesk) {
  const { company, username } = desk;
  const me = company.members.find((member) => member.username === username) ?? null;
  const isFounder = me?.isFounder ?? false;
  const book: CompanyBook = {
    category: company.category,
    fundsCents: company.fundsCents,
    members: company.members.map((member) => ({ userId: member.username, role: member.role, payCents: member.payCents })),
    rooms: company.rooms,
    servers: company.servers,
  };
  return { me, isFounder, canHire: isFounder || (me?.canHire ?? false), book, category: categoryById(company.category) };
}

export function useCompanyDesk(): CompanyDesk | null {
  return useContext(CompanyDeskContext);
}

/** Runs one company action at a time and keeps its one-line result. */
export function useCompanyAction(onDone: () => void) {
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setBusy] = useState(false);
  const act = useCallback(
    async <T>(work: () => Promise<CompanyOutcome<T>>, done: (value: T) => string) => {
      setBusy(true);
      setNotice(null);
      const outcome = await work();
      setBusy(false);
      setNotice(outcome.ok ? done(outcome.value) : companyErrorText(outcome.error, outcome.message));
      if (outcome.ok) onDone();
    },
    [onDone],
  );
  return { act, notice, isBusy };
}
