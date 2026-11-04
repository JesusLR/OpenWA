import { MigrationInterface, QueryRunner } from 'typeorm';

/** Existing sessions stay unassigned; integration clients cannot adopt or enumerate them. */
export class AddSessionSourceSystem1786900000000 implements MigrationInterface {
  name = 'AddSessionSourceSystem1786900000000';

  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('sessions', 'sourceSystem'))) {
      await runner.query('ALTER TABLE "sessions" ADD COLUMN "sourceSystem" varchar(40)');
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('sessions', 'sourceSystem')) {
      await runner.query('ALTER TABLE "sessions" DROP COLUMN "sourceSystem"');
    }
  }
}
