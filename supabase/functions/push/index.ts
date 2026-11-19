// Convoy — push sender.
//
// Wakes a phone that has the app closed. The app writes a row into `events` when something
// worth knowing happens; this function reads the unsent ones, pushes them to every phone
// that registered a subscription, and marks them sent.
//
// Deploy with:
//   supabase functions deploy push --no-verify-jwt
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// Then schedule it every minute (Database → Cron, or an external cron hitting the URL).
//
// Web Push rather than FCM/APNs on purpose: the app is a PWA, and this is the one path that
// works on both Android and an installed iOS app without a native build.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:convoy@example.com';

webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

Deno.serve(async () => {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Anything not yet sent, oldest first, capped so one run cannot run away.
  const { data: events, error } = await db
    .from('events')
    .select('id, kind, body, about, at')
    .is('sent_at', null)
    .order('at', { ascending: true })
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!events || events.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const { data: subs } = await db
    .from('push_subs')
    .select('endpoint, member_id, p256dh, auth');

  let sent = 0;
  const dead: string[] = [];

  for (const ev of events) {
    for (const sub of subs || []) {
      // Do not tell people about their own doing.
      if (ev.about && ev.about === sub.member_id) continue;

      const payload = JSON.stringify({
        title: ev.kind === 'join' ? 'Convoy' : 'Convoy',
        body: ev.body || '',
        tag: ev.kind,
        url: './',
      });

      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        // 404 and 410 mean the subscription is gone: the app was uninstalled, or the
        // browser rotated it. Drop it rather than retrying for ever.
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint);
      }
    }
  }

  if (dead.length) {
    await db.from('push_subs').delete().in('endpoint', dead);
  }
  await db.from('events')
    .update({ sent_at: new Date().toISOString() })
    .in('id', events.map((e) => e.id));

  return new Response(JSON.stringify({ sent, dead: dead.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
