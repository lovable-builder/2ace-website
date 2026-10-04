import { createClient } from 'npm:@supabase/supabase-js@2';

export const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Resolve the caller from their JWT, then their company and Stripe customer.
export async function caller(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  const { data: u } = await admin.auth.getUser(token);
  const user = u?.user;
  if (!user) return null;
  const { data: m } = await admin.from('members').select('org_id, role, organizations(name, stripe_customer_id)').eq('user_id', user.id).limit(1).maybeSingle();
  const org = m?.organizations as { name: string; stripe_customer_id: string | null } | null | undefined;
  return { user, orgId: m?.org_id as string | undefined, role: m?.role as string | undefined, orgName: org?.name, customer: org?.stripe_customer_id ?? null };
}

// ---------- staff (admin panel) ----------
export type StaffRole = 'admin' | 'support' | 'warehouse';
export type StaffCtx = { user: { id: string; email?: string }; role: StaffRole; ip: string | null };

function claims(token: string): Record<string, unknown> {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

// Verifies the JWT, then checks staff_users (active + allowed role) and, for admin/support, a second factor (aal2).
// Staff are never resolved through caller(): the target org is always explicit in the request.
export async function staffCaller(req: Request, roles?: StaffRole[]): Promise<StaffCtx | { error: string; status: number }> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  if (!token) return { error: 'unauthorized', status: 401 };
  const { data: u } = await admin.auth.getUser(token);
  const user = u?.user;
  if (!user) return { error: 'unauthorized', status: 401 };
  const { data: s } = await admin.from('staff_users').select('role, active').eq('user_id', user.id).maybeSingle();
  if (!s || !s.active) return { error: 'no_staff_access', status: 403 };
  const role = s.role as StaffRole;
  if (roles && !roles.includes(role)) return { error: 'forbidden', status: 403 };
  if (role !== 'warehouse' && claims(token).aal !== 'aal2') return { error: 'mfa_required', status: 403 };
  return { user: { id: user.id, email: user.email }, role, ip: req.headers.get('x-forwarded-for')?.split(',')[0] ?? null };
}

// Every staff write records who did what; this is awaited so a write never succeeds without its audit row.
export async function audit(s: StaffCtx, action: string, entity: string, entityId: string | null, orgId: string | null, before: unknown, after: unknown, reason?: string | null) {
  const { error } = await admin.rpc('audit_write', {
    p_actor: s.user.id, p_role: s.role, p_action: action, p_entity: entity, p_entity_id: entityId, p_org: orgId,
    p_before: before ?? null, p_after: after ?? null, p_reason: reason ?? null, p_ip: s.ip,
  });
  if (error) throw new Error('audit failed: ' + error.message);
}
