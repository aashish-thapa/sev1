import { formatCents } from "../../domain/economy.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import type { MyApplication } from "../../storage/company-protocol.ts";

const STATUS_TEXT: Readonly<Record<MyApplication["status"], string>> = {
  pending: "waiting for their decision",
  hired: "hired",
  rejected: "not this time",
};

/** Roles you've interviewed for, and where each stands. */
export function MyApplications({ applications }: { applications: readonly MyApplication[] }) {
  if (applications.length === 0) return null;
  return (
    <section className="company__panel" aria-labelledby="applications-title">
      <h2 id="applications-title" className="admin__heading">
        Your applications
      </h2>
      <ul className="shop">
        {applications.map((application) => (
          <li key={application.id} className="shop__item" data-status={application.status}>
            <span>
              <strong>
                {ROLE_INFO[application.role].label} at {application.companyName}
              </strong>
              <span className="admin__dim">
                {" "}
                · {formatCents(application.payCents)} a day · interview {application.score}%
              </span>
            </span>
            <span className="hq__status">{STATUS_TEXT[application.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
