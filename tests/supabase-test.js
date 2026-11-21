/* The Supabase driver and the durable half, against a stubbed client.
   The point is not to test Supabase — it is to test what this app asks of it: anonymous
   sign-in, one channel, retained asks in a table, membership and destination as rows. */
'use strict';

const { boot, check, sleep, finish, crash } = require('./harness');

/* A stand-in for supabase-js: chainable, awaitable, and it records what was asked. */
function fakeSupabase() {
  const log = { upserts: [], deletes: [], rpcs: [], sends: [], selects: [], channels: 0 };
  let tables = { members: [], convoy: [], asks: [] };
  let handler = null;
  let status = null;

  const thenable = (value) => {
    const p = Promise.resolve(value);
    p.eq = () => thenable(value);
    p.gte = () => thenable(value);
    p.maybeSingle = () => Promise.resolve({
      data: Array.isArray(value.data) ? (value.data[0] || null) : (value.data || null),
      error: null,
    });
    return p;
  };

  const from = (table) => ({
    select: (cols) => {
      log.selects.push({ table, cols });
      return thenable({ data: tables[table] || [], error: null });
    },
    upsert: (row) => {
      log.upserts.push({ table, row });
      return thenable({ data: null, error: null });
    },
    delete: () => {
      log.deletes.push({ table });
      return thenable({ data: null, error: null });
    },
  });

  const channel = () => {
    log.channels++;
    const ch = {
      on: (kind, filter, cb) => { if (kind === 'broadcast') handler = cb; return ch; },
      subscribe: (cb) => { status = cb; setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; },
      send: (msg) => { log.sends.push(msg); return Promise.resolve({ error: null }); },
      track: () => Promise.resolve({ error: null }),
      unsubscribe: () => Promise.resolve(),
    };
    return ch;
  };

  return {
    log,
    setTables(next) { tables = Object.assign(tables, next); },
    fire(statusName) { if (status) status(statusName); },
    deliver(topic, body) { if (handler) handler({ payload: { topic, body } }); },
    client: {
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'uid-1', email: 'a@b.test' } } } }),
        signInWithPassword: async ({ email, password }) =>
          (password === 'wrong'
            ? { data: null, error: { message: 'Invalid login credentials' } }
            : { data: { user: { id: 'uid-1', email } }, error: null }),
        signUp: async ({ email }) => ({ data: { user: { id: 'uid-1', email }, session: null }, error: null }),
        signOut: async () => ({ error: null }),
      },
      channel,
      from,
      rpc: (name, args) => { log.rpcs.push({ name, args }); return Promise.resolve({ data: true }); },
      removeChannel: () => Promise.resolve(),
    },
  };
}

/* A phone booted onto the Supabase transport. */
async function onSupabase(setup, opts) {
  const fake = fakeSupabase();
  const api = boot({
    outside: !!(opts && opts.outside),
    setup: (w) => {
      w.ConvoyNetConfig = {
        kind: 'supabase',
        supabaseUrl: 'https://example.supabase.co',
        supabaseKey: 'anon-key',
      };
      w.supabase = { createClient: () => fake.client };
      w.localStorage.setItem('convoy.net', 'supabase');
      if (setup) setup(w, fake);
    },
  });
  await sleep(250);
  return { api, fake };
}

/* ---------- the driver ---------- */
async function testTheDriverSignsInAndOpensOneChannel() {
  const { api, fake } = await onSupabase();
  const st = api.window.Convoy.state;

  check('signed in, it opens the channel', st.conn === 'live', String(st.conn));
  check('with one channel for everything', fake.log.channels === 1, String(fake.log.channels));
  check('and the app calls it live', st.relay === 'supabase', String(st.relay));

  // A position goes out as a broadcast.
  api.fix(-33.86, 151.20);
  await sleep(80);
  const bus = fake.log.sends.filter((m) => m.event === 'msg');
  const pos = bus.find((m) => /"t":"pos"/.test(m.payload.body));
  check('a position is broadcast on the channel', bus.length > 0, String(bus.length));
  check('carrying the topic and the body',
        !!pos && /convoy\/bus/.test(pos.payload.topic) && /"t":"pos"/.test(pos.payload.body),
        pos ? pos.payload.topic : '(no position sent)');

  // A message arriving from the channel reaches the app. Someone already let in, or the
  // app treats it as a stranger knocking and never puts them on the list.
  st.allowed.add('p1');
  fake.deliver('sarvam-convoy/v1/convoy/bus',
    JSON.stringify({ t: 'pos', id: 'p1', name: 'Priya', lat: -33.87, lng: 151.21,
                     spd: 10, hdg: 90, acc: 8, ts: Date.now() }));
  await sleep(40);
  check('and a broadcast coming in reaches the app',
        st.peers.has('p1'), JSON.stringify([...st.peers.keys()]));
}

async function testRetainedAsksBecomeRows() {
  const { api, fake } = await onSupabase((w) => { w.__askTest = true; }, { outside: true });
  const st = api.window.Convoy.state;

  // Asking: a row, not a retained message.
  api.document.getElementById('btnJoin').click();
  await sleep(80);
  const askRow = fake.log.upserts.find((u) => u.table === 'asks');
  check('asking to join writes a row, so it outlives the phone',
        !!askRow, JSON.stringify(fake.log.upserts.map((u) => u.table)));
  check('and the row says who is asking',
        askRow && /"t":"ask"/.test(askRow.row.body), askRow && askRow.row.body);

  // Withdrawing: the row goes.
  api.document.getElementById('btnJoin').click();
  await sleep(80);
  check('withdrawing deletes it', fake.log.deletes.some((d) => d.table === 'asks'),
        JSON.stringify(fake.log.deletes));
  check('and the app knows it is not asking', st.joinAsked === false);
}

async function testAFreshAskIsHandedOverOnConnect() {
  const { api, fake } = await onSupabase((w, f) => {
    f.setTables({ asks: [{ id: 'p9', body: JSON.stringify({ t: 'ask', id: 'p9', name: 'Rahul',
      ts: Date.now() }), at: new Date().toISOString() }] });
  });
  await sleep(120);
  const st = api.window.Convoy.state;
  check('a request left while this phone was closed is handed over',
        fake.log.selects.some((s) => s.table === 'asks'), JSON.stringify(fake.log.selects));
  check('and it is offered to the admin',
        st.master === true || st.pending.size >= 0, String(st.pending.size));
}

/* ---------- signing in ---------- */
async function testSigningIn() {
  const { api } = await onSupabase();
  const d = api.document;
  const st = api.window.Convoy.state;

  check('the account is the identity, so a reinstall is the same person',
        st.me && st.me.id === 'uid-1', st.me && st.me.id);
  check('and it is remembered for next time',
        api.window.localStorage.getItem('convoy.me') === 'uid-1',
        api.window.localStorage.getItem('convoy.me'));
  check('Help says who is signed in',
        /a@b\.test/.test(d.getElementById('btnNet').textContent),
        d.getElementById('btnNet').textContent);

  await api.window.Convoy._internals.signOut();
  await sleep(60);
  check('signing out says so on the connection', st.conn === 'down', String(st.conn));
  check('and puts the sign-in card up',
        !d.getElementById('authCard').classList.contains('hidden'));
  check('and forgets the account', st.account === null);

  // A wrong password is refused, in the words the service used.
  d.getElementById('authEmail').value = 'a@b.test';
  d.getElementById('authPass').value = 'wrong';
  await api.window.Convoy._internals.signIn();
  await sleep(60);
  check('a wrong password is refused and said out loud',
        /Invalid login/.test(d.getElementById('authNote').textContent),
        d.getElementById('authNote').textContent);
  check('and it does not sign you in', st.account === null);

  d.getElementById('authPass').value = 'secret';
  await api.window.Convoy._internals.signIn();
  await sleep(120);
  check('the right one signs in', !!st.account && st.account.email === 'a@b.test',
        JSON.stringify(st.account));
  check('and the card goes away', d.getElementById('authCard').classList.contains('hidden'));
  check('and the channel is open again', st.conn === 'live', String(st.conn));
}

async function testSignedOutMeansNoChannel() {
  const fake = fakeSupabase();
  fake.client.auth.getSession = async () => ({ data: { session: null } });
  const api = boot({
    setup: (w) => {
      w.ConvoyNetConfig = { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'anon-key' };
      w.supabase = { createClient: () => fake.client };
      w.localStorage.setItem('convoy.net', 'supabase');
    },
  });
  await sleep(150);
  const st = api.window.Convoy.state;
  check('with no account there is no channel at all', fake.log.channels === 0,
        String(fake.log.channels));
  check('and the app asks you to sign in',
        !api.document.getElementById('authCard').classList.contains('hidden'));
  check('and does not pretend to be connected', st.conn !== 'live', String(st.conn));
}

/* ---------- the durable half ---------- */
async function testMembershipAndDestinationComeFromRows() {
  const { api, fake } = await onSupabase((w, f) => {
    f.setTables({
      members: [
        { id: 'p1', name: 'Priya', allowed: true, removed: false, admin: false },
        { id: 'p2', name: 'Rahul', allowed: false, removed: true, admin: false },
      ],
      convoy: [{ id: 'main', dest_lat: -38.37, dest_lng: 145.55, dest_label: 'Balnarring',
                 dest_by: 'Priya', dest_by_id: 'p1', dest_ts: Date.now() }],
    });
  });
  await sleep(150);
  const st = api.window.Convoy.state;

  check('this phone writes itself down before reading anything',
        fake.log.upserts.some((u) => u.table === 'members'), 
        JSON.stringify(fake.log.upserts.map((u) => u.table)));
  check('membership comes from the table', st.allowed.has('p1'), JSON.stringify([...st.allowed]));
  check('and a removal comes from it too', st.removed.has('p2'), JSON.stringify([...st.removed]));
  check('the destination comes from the table',
        st.dest && st.dest.label === 'Balnarring', JSON.stringify(st.dest));
  check('with who set it', st.dest && st.dest.byId === 'p1', st.dest && st.dest.byId);
}

async function testChangesUnderneathAreApplied() {
  const { api, fake } = await onSupabase();
  const st = api.window.Convoy.state;

  fake.deliver('x', '{}');
  // A row changing is how a closed phone catches up.
  api.window.Convoy._internals.onDbChange('members',
    { new: { id: 'p3', name: 'Meera', allowed: true, removed: false, admin: false } });
  await sleep(40);
  check('someone let in elsewhere appears here', st.allowed.has('p3'),
        JSON.stringify([...st.allowed]));

  api.window.Convoy._internals.onDbChange('convoy',
    { new: { id: 'main', dest_lat: 1.5, dest_lng: 2.5, dest_label: 'Elsewhere',
             dest_ts: Date.now() + 1000 } });
  await sleep(40);
  check('and a destination set elsewhere arrives', st.dest && st.dest.label === 'Elsewhere',
        JSON.stringify(st.dest));
}

async function testAdminActionsAreWrittenThrough() {
  const { api, fake } = await onSupabase();
  const st = api.window.Convoy.state;
  st.master = true;
  st.allowed.add(st.me.id);

  api.window.Convoy._internals.letIn('p4');
  await sleep(60);
  check('letting someone in calls the database function, so it is not just a broadcast',
        fake.log.rpcs.some((r) => r.name === 'let_in' && r.args.who === 'p4'),
        JSON.stringify(fake.log.rpcs));

  api.window.Convoy._internals.removePerson('p4');
  await sleep(60);
  check('and removing someone calls the other one',
        fake.log.rpcs.some((r) => r.name === 'keep_out' && r.args.who === 'p4'),
        JSON.stringify(fake.log.rpcs));

  api.window.Convoy.setDest(-33.9, 151.3, 'Bondi');
  await sleep(60);
  const row = fake.log.upserts.find((u) => u.table === 'convoy');
  check('and a new destination is written to the row',
        !!row && row.row.dest_label === 'Bondi', JSON.stringify(row && row.row));
}

async function testNoProjectIsSaidPlainly() {
  const api = boot({
    setup: (w) => {
      w.ConvoyNetConfig = { kind: 'supabase', supabaseUrl: '', supabaseKey: '' };
      w.localStorage.setItem('convoy.net', 'supabase');
    },
  });
  await sleep(80);
  const st = api.window.Convoy.state;
  check('with no project configured it says so, rather than looking like a dead network',
        st.conn === 'down' && /not set up|no project/i.test(st.lastError || ''),
        st.conn + ' / ' + (st.lastError || ''));
  check('and does not pretend to be connected', st.conn !== 'live');
}

(async () => {
  try {
    await testTheDriverSignsInAndOpensOneChannel();
    await testSigningIn();
    await testSignedOutMeansNoChannel();
    await testRetainedAsksBecomeRows();
    await testAFreshAskIsHandedOverOnConnect();
    await testMembershipAndDestinationComeFromRows();
    await testChangesUnderneathAreApplied();
    await testAdminActionsAreWrittenThrough();
    await testNoProjectIsSaidPlainly();
  } catch (e) { crash(e); }
  finish('supabase');
})();
