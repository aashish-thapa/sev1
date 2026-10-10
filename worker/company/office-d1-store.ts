import type { OfficeRoomStore } from "./office.ts";

export class D1OfficeRoomStore implements OfficeRoomStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async companyOfMember(userId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT companies.id FROM company_members JOIN companies ON companies.id = company_members.company_id WHERE company_members.user_id = ? AND companies.state = 'active'")
      .bind(userId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async roomCodeOf(companyId: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT room_code FROM companies WHERE id = ?").bind(companyId).first<{ room_code: string | null }>();
    return row?.room_code ?? null;
  }

  async assignRoomCode(companyId: string, code: string): Promise<boolean> {
    try {
      const result = await this.db.prepare("UPDATE companies SET room_code = ? WHERE id = ? AND room_code IS NULL").bind(code, companyId).run();
      return result.meta.changes === 1;
    } catch (error) {
      // The unique index refused a code another company already holds; anything else is a real failure.
      if (error instanceof Error && error.message.includes("UNIQUE")) return false;
      throw error;
    }
  }

  async companyOfRoom(code: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT id FROM companies WHERE room_code = ?").bind(code).first<{ id: string }>();
    return row?.id ?? null;
  }
}
