import { useCallback, useEffect, useMemo, useState } from "react";
import type { LaptopApp } from "../../../warroom/ui/laptop-apps.ts";
import type { CompanyApi } from "../../../storage/company-api.ts";
import type { Company, DealWire, MyCompany } from "../../../storage/company-protocol.ts";
import { BooksApp } from "./BooksApp.tsx";
import { DealApp } from "./DealApp.tsx";
import type { CompanyDesk } from "./desk.ts";
import { OfficeApp } from "./OfficeApp.tsx";
import { TeamApp } from "./TeamApp.tsx";
import { WorkApp } from "./WorkApp.tsx";

/** How often an open term sheet is read again, so the other side's changes show up while you talk. */
const DEAL_POLL_MS = 3_000;

type Options = {
  /** The company whose office you're standing in, or null when you're not in one. */
  officeCompanyId: string | null;
  /** The floor draws from the same books (its board, its racks), so it hears every refetch too. */
  onCompany?: (company: Company) => void;
  /** Called once a deal you're investing in is agreed: pay for it from the wallet. */
  onAgreed?: (deal: DealWire) => void;
};

/**
 * What your laptop runs in a company's office: its tools if you work there, and the term sheet
 * for any investment you're there to agree. Nothing anywhere else.
 */
export function useCompanyLaptopApps(api: CompanyApi, username: string | null, { officeCompanyId, onCompany, onAgreed }: Options): readonly LaptopApp[] {
  const [mine, setMine] = useState<MyCompany | null>(null);
  const company = mine?.company && mine.company.id === officeCompanyId ? mine.company : null;
  const deals = useMemo(() => mine?.deals.filter((deal) => deal.companyId === officeCompanyId) ?? [], [mine, officeCompanyId]);
  const isNegotiating = deals.some((deal) => deal.stage === "talking");

  useEffect(() => {
    if (company) onCompany?.(company);
  }, [company, onCompany]);

  useEffect(() => {
    for (const deal of deals) if (deal.stage === "agreed" && deal.investRef && deal.investor === username) onAgreed?.(deal);
  }, [deals, onAgreed, username]);

  const refresh = useCallback(() => {
    void api.mine().then((read) => read.ok && setMine(read.value));
  }, [api]);

  useEffect(() => {
    if (officeCompanyId === null) return;
    const controller = new AbortController();
    api.mine(controller.signal).then((read) => read.ok && setMine(read.value), () => undefined);
    return () => controller.abort();
  }, [api, officeCompanyId]);

  useEffect(() => {
    if (!isNegotiating) return;
    const timer = setInterval(refresh, DEAL_POLL_MS);
    return () => clearInterval(timer);
  }, [isNegotiating, refresh]);

  return useMemo(() => {
    if (officeCompanyId === null) return [];
    const apps: LaptopApp[] = [];
    if (deals.length > 0) apps.push({ id: "deal", title: "Deal", render: () => <DealApp api={api} deals={deals} username={username} onChanged={refresh} /> });
    if (company) {
      const desk: CompanyDesk = { api, company, username, refresh };
      apps.push(
        { id: "work", title: "Work", render: () => <WorkApp desk={desk} /> },
        { id: "office", title: "Office", render: () => <OfficeApp desk={desk} /> },
        { id: "team", title: "Team", render: () => <TeamApp desk={desk} /> },
        { id: "books", title: "Books", render: () => <BooksApp desk={desk} /> },
      );
    }
    return apps;
  }, [api, company, deals, officeCompanyId, refresh, username]);
}
