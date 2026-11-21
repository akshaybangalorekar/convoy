/* A stand-in for Supabase that several apps can share, the way makeBroker() stands in for
   the MQTT relays.

   It is deliberately not a mock of the library — it is a small in-memory Postgres with one
   channel: broadcasts reach every other app on it, table writes notify every app watching,
   and the admin guard is enforced the same way the trigger enforces it in the real database.
   That last part matters: it is what catches a client trying to promote itself.

   Each app's client also carries the MQTT fake's surface — `published`, `_emit` — so every
   existing test runs against it without being rewritten. */

function makeSupabase() {
  const db = {
    members: new Map(),        // id -> row
    convoy: { id: 'main', dest_lat: null, dest_lng: null, dest_label: null,
              dest_by: null, dest_by_id: null, dest_ts: 0 },
    asks: new Map(),           // id -> { id, body, at }
    subs: new Map(),           // endpoint -> row
    events: [],
  };
  const channels = [];         // { uid, onBroadcast, onChange, statusCb }
  let uidSeq = 0;

  const isAdmin = (uid) => {
    for (const row of db.members.values()) {
      if (row.user_id === uid && row.admin) return true;
    }
    return false;
  };

  /* Several watchers per channel, each with its own table filter — a channel can watch
     members, convoy and asks at once, and one handler must not displace another. */
  const notify = (table, next, old) => {
    channels.forEach((c) => {
      (c.onChanges || []).forEach((h) => {
        if (h.table && h.table !== table) return;
        try { h.cb({ eventType: old ? 'UPDATE' : 'INSERT', new: next, old }); }
        catch (e) { /* ignore */ }
      });
    });
  };

  /* The trigger from 0001_init.sql, in miniature: only an admin may move someone between
     allowed and removed, or hand out admin. A member may still change their own name. */
  function guardedUpdate(id, patch, uid) {
    const row = db.members.get(id);
    if (!row) return { error: { message: 'no such member' } };
    const touchesMembership = ('allowed' in patch && patch.allowed !== row.allowed) ||
      ('removed' in patch && patch.removed !== row.removed) ||
      ('admin' in patch && patch.admin !== row.admin);
    if (touchesMembership && !isAdmin(uid)) {
      /* Anyone who has been in before may take themselves out and put themselves back in.
         A phone that has never been in needs the pin. */
      const selfServe = row.user_id === uid && patch.admin === undefined && row.was_in;
      if (!selfServe) return { error: { message: 'only an admin can change who is in' } };
    }
    const next = Object.assign({}, row, patch);
    if (next.allowed) next.was_in = true;   // once in, always was in
    db.members.set(id, next);
    notify('members', next, row);
    return { data: next, error: null };
  }

  /* One account, however many clients it makes: a reconnect is the same person, and the
     identity must not drift every time the channel is rebuilt. */
  function createClient(accountId) {
    const uid = accountId || ('uid-' + (++uidSeq));
    let myChannel = null;
    const app = { published: [], connected: true, subscriptions: [], ended: false, uid };

    const channel = () => {
      const c = { uid, onBroadcast: null, onChanges: [], statusCb: null, subscribed: false };
      channels.push(c);
      myChannel = c;
      const api = {
        on(kind, filter, cb) {
          if (kind === 'broadcast') c.onBroadcast = cb;
          if (kind === 'postgres_changes') {
            c.onChanges.push({ table: (filter && filter.table) || null, event: (filter && filter.event) || '*', cb });
          }
          return api;
        },
        subscribe(cb) {
          c.subscribed = true;
          c.statusCb = cb;
          setTimeout(() => cb && cb('SUBSCRIBED'), 0);
          return api;
        },
        send(msg) {
          if (msg && msg.type === 'broadcast') {
            app.published.push(String((msg.payload && msg.payload.body) || ''));
            channels.forEach((other) => {
              if (other === c || !other.onBroadcast) return;   // self: false, as configured
              try { other.onBroadcast({ payload: msg.payload }); } catch (e) { /* ignore */ }
            });
          }
          return Promise.resolve({ error: null });
        },
        track() { return Promise.resolve({ error: null }); },
        unsubscribe() { return Promise.resolve(); },
      };
      return api;
    };

    /* A query builder that is awaitable at any point, like the real one. */
    const from = (table) => {
      const rows = () => {
        if (table === 'convoy') return [db.convoy];
        return Array.from(db[table] ? db[table].values() : []);
      };
      let current = rows();
      const q = {
        _one: false,
        select() { return q; },
        eq(col, val) { current = current.filter((r) => r[col] === val); return q; },
        gte(col, val) { current = current.filter((r) => String(r[col]) >= String(val)); return q; },
        is(col, val) { current = current.filter((r) => (r[col] == null) === (val === null)); return q; },
        order() { return q; },
        limit(n) { current = current.slice(0, n); return q; },
        maybeSingle() { q._one = true; return q; },
        then(resolve, reject) {
          const data = q._one ? (current[0] || null) : current.slice();
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
        upsert(row, opts) {
          const key = (opts && opts.onConflict) || 'id';
          if (table === 'members') {
            const existing = db.members.get(row[key]);
            if (existing) return Promise.resolve(guardedUpdate(row[key], row, uid));
            const fresh = Object.assign({ allowed: false, removed: false, admin: false }, row);
            db.members.set(row[key], fresh);
            notify('members', fresh, null);
            return Promise.resolve({ data: fresh, error: null });
          }
          if (table === 'convoy') {
            const old = Object.assign({}, db.convoy);
            Object.assign(db.convoy, row);
            notify('convoy', db.convoy, old);
            return Promise.resolve({ data: db.convoy, error: null });
          }
          if (table === 'asks') {
            const fresh = Object.assign({ at: new Date().toISOString() }, row);
            db.asks.set(row.id, fresh);
            // A request that arrives while a phone is open is news: tell the watchers.
            notify('asks', fresh, null);
            return Promise.resolve({ data: row, error: null });
          }
          if (table === 'push_subs') {
            db.subs.set(row.endpoint, row);
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) {
          const upd = {
            eq(col, val) {
              if (table === 'members') return Promise.resolve(guardedUpdate(val, patch, uid));
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve, reject) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return upd;
        },
        insert(row) {
          if (table === 'events') {
            db.events.push(Object.assign({ at: new Date().toISOString() }, row));
            return Promise.resolve({ data: row, error: null });
          }
          if (table === 'asks') {
            db.asks.set(row.id, row);
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        delete() {
          const del = {
            eq(col, val) {
              if (table === 'asks') db.asks.delete(val);
              if (table === 'push_subs') db.subs.delete(val);
              return Promise.resolve({ data: null, error: null });
            },
            in(col, vals) {
              (vals || []).forEach((v) => { if (table === 'push_subs') db.subs.delete(v); });
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve, reject) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return del;
        },
      };
      return q;
    };

    const rpc = (name, args) => {
      if (name === 'let_in') {
        if (!isAdmin(uid)) return Promise.resolve({ data: false, error: { message: 'not admin' } });
        const r = guardedUpdate(args.who, { allowed: true, removed: false }, uid);
        return Promise.resolve({ data: !r.error, error: r.error || null });
      }
      if (name === 'keep_out') {
        if (!isAdmin(uid)) return Promise.resolve({ data: false, error: { message: 'not admin' } });
        const r = guardedUpdate(args.who, { allowed: false, removed: true }, uid);
        return Promise.resolve({ data: !r.error, error: r.error || null });
      }
      if (name === 'claim_admin') {
        const mine = Array.from(db.members.values()).find((m) => m.user_id === uid);
        if (!mine) return Promise.resolve({ data: false, error: null });
        const next = Object.assign({}, mine, { admin: true, allowed: true, removed: false });
        db.members.set(mine.id, next);
        notify('members', next, mine);
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };

    /* The surface the MQTT fake client has, so recv/goLive/sent and the drop tests work
       unchanged against this transport. */
    let session = { user: { id: uid, email: uid + '@example.test' } };

    app._emit = (event, ...args) => {
      if (event === 'message') {
        const [topic, payload] = args;
        const body = String(payload && payload.toString ? payload.toString() : payload || '');
        if (myChannel && myChannel.onBroadcast) {
          try { myChannel.onBroadcast({ payload: { topic, body } }); } catch (e) { /* ignore */ }
        }
        return;
      }
      if (event === 'close') {
        if (myChannel && myChannel.statusCb) {
          try { myChannel.statusCb('CHANNEL_ERROR'); } catch (e) { /* ignore */ }
        }
        return;
      }
      /* "The link came up" on this transport means the channel re-subscribed, which is what
         makes a reconnect look like a reconnect here too. */
      if (event === 'connect') {
        if (myChannel && myChannel.statusCb) {
          try { myChannel.statusCb('SUBSCRIBED'); } catch (e) { /* ignore */ }
        }
      }
    };

    Object.assign(app, {
      auth: {
        getSession: async () => ({ data: { session } }),
        signInWithPassword: async ({ email, password }) => {
          if (!email || !password) return { data: null, error: { message: 'email and password' } };
          if (password === 'wrong') return { data: null, error: { message: 'Invalid login' } };
          session = { user: { id: uid, email } };
          return { data: { user: session.user, session }, error: null };
        },
        signUp: async ({ email, password }) => {
          if (!email || !password) return { data: null, error: { message: 'email and password' } };
          if (email.indexOf('confirm') >= 0) {
            // A project that asks for confirmation returns no session: a step, not a failure.
            return { data: { user: { id: uid, email }, session: null }, error: null };
          }
          session = { user: { id: uid, email } };
          return { data: { user: session.user, session }, error: null };
        },
        signOut: async () => { session = null; return { error: null }; },
      },
      channel,
      from,
      rpc,
      removeChannel: () => {
        const i = channels.indexOf(myChannel);
        if (i >= 0) channels.splice(i, 1);
        return Promise.resolve();
      },
    });
    return app;
  }

  return {
    kind: 'supabase',
    createClient,
    db,
    // What a test needs to look at afterwards.
    rows: (table) => (table === 'convoy' ? [db.convoy] : Array.from(db[table].values())),
    adminCount: () => Array.from(db.members.values()).filter((m) => m.admin).length,
    __debug: () => channels.map((c) => ({ uid: c.uid, changes: (c.onChanges || []).map((h) => h.table) })),
  };
}

module.exports = { makeSupabase };
