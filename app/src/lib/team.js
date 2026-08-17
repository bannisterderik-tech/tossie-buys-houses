/**
 * The one team, seeded in 20260817120000_foundation.sql.
 *
 * Inserts have to name a team_id and RLS checks it against get_my_team_id(), so
 * a wrong value here fails the WITH CHECK rather than writing to the wrong
 * place. When Tossie ever becomes multi-tenant this reads from the session
 * profile instead of being a constant.
 */
export const TEAM_ID = '70551e00-0000-4000-8000-000000000001';
