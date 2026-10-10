import { useState } from "react";
import type { CategoryId } from "../../domain/company/catalog.ts";
import type { Role } from "../../domain/incident.ts";
import { ROLE_INFO } from "../../domain/roles.ts";
import { isDone, tasksForDay, type Task } from "../../domain/work/task.ts";
import { TaskView } from "./TaskViews.tsx";

/** Tasks on the board each work day. */
export const TASKS_PER_DAY = 3;

type Props = {
  tasks: readonly Task[];
  role: Role;
  category: CategoryId | null;
  /** The local day, YYYY-MM-DD: the board stays the same all day. */
  day: string;
  /** Ids finished on earlier days, so fresh tasks come first. */
  finishedBefore: ReadonlySet<string>;
  /** Ids shipped today; a task already shipped shows as done. */
  shippedToday: ReadonlySet<string>;
  onShipped: (taskId: string) => void;
};

/** Today's work for your role: bugs to fix and pull requests to review. */
export function WorkBoard({ tasks, role, category, day, finishedBefore, shippedToday, onShipped }: Props) {
  const today = tasksForDay(tasks, role, category, day, finishedBefore, TASKS_PER_DAY);
  const [openId, setOpenId] = useState<string | null>(null);

  if (today.length === 0) return <p className="company__note">No {ROLE_INFO[role].label} tasks for this company yet.</p>;
  return (
    <section className="company__panel" aria-labelledby="work-title">
      <h2 id="work-title" className="admin__heading">
        Today’s work · {ROLE_INFO[role].label}
      </h2>
      <p className="company__note">
        {shippedToday.size} of {today.length} shipped. Finished work raises the day’s revenue when the work day closes.
      </p>
      <ul className="work">
        {today.map((task) => {
          const isShipped = shippedToday.has(task.id);
          const isOpen = openId === task.id;
          return (
            <li key={task.id} className="work__item" data-shipped={isShipped}>
              <button type="button" className="work__toggle" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : task.id)}>
                <span className="work__kind">{task.kind === "code-fix" ? "Bug" : "Review"}</span>
                <span className="work__title">{task.title}</span>
                <span className="work__state">{isShipped ? "✓ shipped" : "open"}</span>
              </button>
              {isOpen && (
                <TaskView
                  // A fresh attempt each time the task is opened; shipping is what's remembered.
                  key={`${task.id}:${isShipped}`}
                  task={task}
                  day={day}
                  onFinish={(outcome) => {
                    if (isDone(outcome)) onShipped(task.id);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
