import { useCallback, useEffect, useMemo, useState } from "react";
import type { LaptopApp } from "../../../warroom/ui/laptop-apps.ts";
import type { CompanyApi } from "../../../storage/company-api.ts";
import type { Company } from "../../../storage/company-protocol.ts";
import { BooksApp } from "./BooksApp.tsx";
import type { CompanyDesk } from "./desk.ts";
import { OfficeApp } from "./OfficeApp.tsx";
import { TeamApp } from "./TeamApp.tsx";
import { WorkApp } from "./WorkApp.tsx";

/** The company's tools on your laptop while you're in its office; none anywhere else. */
export function useCompanyLaptopApps(api: CompanyApi, username: string | null, isInOffice: boolean): readonly LaptopApp[] {
  const [company, setCompany] = useState<Company | null>(null);

  const refresh = useCallback(() => {
    void api.mine().then((mine) => setCompany(mine.ok ? mine.value.company : null));
  }, [api]);

  useEffect(() => {
    if (!isInOffice) return;
    const controller = new AbortController();
    api.mine(controller.signal).then((mine) => setCompany(mine.ok ? mine.value.company : null), () => undefined);
    return () => controller.abort();
  }, [api, isInOffice]);

  return useMemo(() => {
    if (!isInOffice || !company) return [];
    const desk: CompanyDesk = { api, company, username, refresh };
    return [
      { id: "work", title: "Work", render: () => <WorkApp desk={desk} /> },
      { id: "office", title: "Office", render: () => <OfficeApp desk={desk} /> },
      { id: "team", title: "Team", render: () => <TeamApp desk={desk} /> },
      { id: "books", title: "Books", render: () => <BooksApp desk={desk} /> },
    ];
  }, [api, company, isInOffice, refresh, username]);
}
