/**
 * The daily-work task packs, bundled into the worker so interviews are built and graded on the
 * server. The same files feed the client; adding a pack means adding it here too.
 */
import { createTaskLibrary } from "../../src/content/task-library.ts";
import type { Task } from "../../src/domain/work/task.ts";
import data from "../../src/content/tasks/data.json";
import frontend from "../../src/content/tasks/frontend.json";
import infrastructure from "../../src/content/tasks/infrastructure.json";
import mobile from "../../src/content/tasks/mobile.json";
import security from "../../src/content/tasks/security.json";

export const TASKS: readonly Task[] = createTaskLibrary({ data, frontend, infrastructure, mobile, security });
