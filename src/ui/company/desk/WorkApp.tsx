import { ROLE_INFO } from "../../../domain/roles.ts";
import { WorkBoard } from "../../work/WorkBoard.tsx";
import { useDesk, type CompanyDesk } from "./desk.ts";

/** Today's bugs and reviews for your role at the company. */
export function WorkApp({ desk }: { desk: CompanyDesk }) {
  const { me } = useDesk(desk);
  if (!me) return <p className="company__note">You’re visiting; only staff have work here.</p>;
  return (
    <div className="desk">
      <WorkBoard api={desk.api} roleLabel={ROLE_INFO[me.role].label} version={desk.company.workDay} />
    </div>
  );
}
