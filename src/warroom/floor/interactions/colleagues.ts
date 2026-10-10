import { AVATARS, type Sex } from "../assets/catalog.ts";
import { PEOPLE, seatOf, type Person } from "../office.ts";

/** Someone you can walk up to and talk to: at a desk, or standing about (not the presenters at the screens). */
export type Colleague = { readonly id: string; readonly name: string; readonly x: number; readonly z: number; readonly isSeated: boolean };

// Distinct from the incident channel's cast (Maya, Sam, Elena, Priya, Jonas, Lena, Omar) so nobody is in two places.
const FIRST_NAMES: Readonly<Record<Sex, readonly string[]>> = {
  female: ["Aisha", "Hannah", "Mei", "Sofia", "Grace", "Nadia", "Chloe", "Ifeoma", "Yuki", "Rosa", "Freya", "Leila", "Dana"],
  male: ["Dev", "Marcus", "Tomás", "Kenji", "Ravi", "Felix", "Kwame", "Arjun", "Luca", "Ben", "Hamid", "Noah", "Ivan"],
};

const SEX = new Map(AVATARS.map((avatar) => [avatar.id, avatar.sex]));

function isChattable(person: Person): person is Extract<Person, { kind: "seated" | "standing" }> {
  return person.kind === "seated" || (person.kind === "standing" && person.activity !== "presenting");
}

/** Everyone you can chat with, each with a first name unique in the office. */
export function colleaguesIn(people: readonly Person[] = PEOPLE): Colleague[] {
  const used: Record<Sex, number> = { female: 0, male: 0 };
  return people.filter(isChattable).map((person) => {
    const sex = SEX.get(person.avatar) ?? "male";
    const pool = FIRST_NAMES[sex];
    const name = pool[used[sex] % pool.length];
    used[sex] += 1;
    const spot = person.kind === "seated" ? seatOf(person.desk) : { x: person.x, z: person.z };
    return { id: person.id, name, x: spot.x, z: spot.z, isSeated: person.kind === "seated" };
  });
}
