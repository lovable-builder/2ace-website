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
