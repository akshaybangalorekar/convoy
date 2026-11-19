/* The transport, behind one interface, with two drivers: the public MQTT relays the app
   has always used, and Supabase. The app above this line does not know which one is
   running — it publishes a topic and gets messages back, exactly as before — which is what
   makes the two switchable from inside the app and testable against the same suites.

   The ask topics are the one thing that is not a plain broadcast: they are retained, so a
   request outlives the phone that sent it. On MQTT the broker holds it. On Supabase it goes
   in a table, which is stronger — it survives a broker restart, and a pin phone can be
   closed for a week and still find it. */
(function () {
  'use strict';

  const ASK = /\/ask\/([^/]+)$/;

  /* ---------------------------------------------------------------- MQTT */

  function mqttDriver(cfg) {
    let client = null;
    let live = false;
    return {
      kind: 'mqtt',
      get connected() { return !!(client && client.connected) && live; },
      start() {
        if (typeof mqtt === 'undefined' || !mqtt || !mqtt.connect) {
          cfg.onError(new Error('no mqtt library'));
          return;
        }
        client = mqtt.connect(cfg.url, {
          clientId: cfg.clientId,
          clean: true,
          reconnectPeriod: 0,
          keepalive: cfg.keepalive,
        });
        client.on('connect', () => { live = true; cfg.onOpen(); });
        client.on('message', (t, p) => cfg.onMessage(t, p));
        client.on('error', (e) => cfg.onError(e));
        // The disconnect packet carries the reason code — 135 is "not authorized", and
        // without it a refused connection looks exactly like a blocked port.
        client.on('disconnect', (pkt) => { if (cfg.onDisconnect) cfg.onDisconnect(pkt); });
        client.on('close', () => { live = false; cfg.onClose(); });
      },
      publish(topic, body, opts) {
        if (!client) return;
        try { client.publish(topic, body, opts || {}); } catch (e) { /* ignore */ }
      },
      subscribe(topic) {
        if (client) { try { client.subscribe(topic, { qos: 0 }, () => {}); } catch (e) {} }
      },
      unsubscribe(topic) {
        if (client) { try { client.unsubscribe(topic, () => {}); } catch (e) {} }
      },
      end() {
        live = false;
        if (client) { try { client.end(true); } catch (e) { /* ignore */ } client = null; }
      },
      // MQTT has no anonymous identity: the app already has one, and it is the same on both.
      uid() { return null; },
    };
  }

  /* ---------------------------------------------------------------- Supabase */

  function supabaseDriver(cfg) {
    let sb = null;
    let channel = null;
    let uid = null;
    let stopped = false;

    const bodyOf = (b) => (typeof b === 'string' ? b : (b == null ? '' : String(b)));

    async function signIn() {
      /* Anonymous sign-in gives a real auth.uid() with no sign-up screen, which is what
         lets row-level security decide who may do what. It is remembered in localStorage by
         supabase-js, so a reload is the same person. */
      const { data } = await sb.auth.getSession();
      if (data && data.session && data.session.user) return data.session.user.id;
      const { data: made, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      return made.user.id;
    }

    async function loadAsks() {
      // Retained requests, handed over on connect — the same thing the broker did.
      try {
        const { data } = await sb.from('asks').select('id, body, at')
          .gte('at', new Date(Date.now() - cfg.askFreshMs).toISOString());
        (data || []).forEach((row) => {
          cfg.onMessage(cfg.askPrefix + row.id, { toString: () => row.body || '' });
        });
      } catch (e) { /* the bus still works without them */ }
    }

    let live = false;
    return {
      kind: 'supabase',
      get connected() { return live; },
      async start() {
        if (typeof supabase === 'undefined' || !supabase.createClient) {
          cfg.onError(new Error('no supabase library'));
          return;
        }
        try {
          sb = supabase.createClient(cfg.url, cfg.key, {
            auth: { persistSession: true, autoRefreshToken: true },
          });
          uid = await signIn();
        } catch (e) {
          cfg.onError(e);
          return;
        }

        channel = sb.channel('convoy', {
          config: { broadcast: { self: false }, presence: { key: uid } },
        });

        channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
          if (!payload) return;
          cfg.onMessage(payload.topic, { toString: () => payload.body || '' });
        });

        // Durable changes — membership, the destination — arrive as table changes, so a
        // phone that was closed still learns what happened while it was away.
        ['members', 'convoy'].forEach((table) => {
          channel.on('postgres_changes', { event: '*', schema: 'public', table }, (row) => {
            cfg.onChange(table, row);
          });
        });

        channel.subscribe((status) => {
          if (stopped) return;
          if (status === 'SUBSCRIBED') {
            live = true;
            cfg.onOpen();
            loadAsks();
            try { channel.track({ at: Date.now() }); } catch (e) { /* presence is optional */ }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            live = false;
            cfg.onClose();
          }
        });
      },

      publish(topic, body, opts) {
        if (!sb) return;
        const text = bodyOf(body);
        const ask = ASK.exec(topic);
        if (ask) {
          // Retained: an empty body is a withdrawal, exactly as on MQTT.
          if (!text) {
            sb.from('asks').delete().eq('id', ask[1]).then(() => {}, () => {});
            return;
          }
          sb.from('asks').upsert({ id: ask[1], body: text, at: new Date().toISOString() })
            .then(() => {}, () => {});
          return;
        }
        if (!channel) return;
        channel.send({ type: 'broadcast', event: 'msg', payload: { topic, body: text } })
          .then(() => {}, () => {});
      },

      subscribe(topic) {
        // Broadcast arrives for everything on the channel; the only subscription that needs
        // doing is the retained one, and that is loaded on connect.
        if (/\/ask\/\+$/.test(topic)) return;
      },

      unsubscribe() { /* nothing to do: one channel carries everything */ },

      end() {
        stopped = true;
        live = false;
        try { if (sb) sb.removeChannel(channel); } catch (e) { /* ignore */ }
        channel = null;
      },

      uid() { return uid; },
      client() { return sb; },
    };
  }

  /* ---------------------------------------------------------------- the seam */

  window.ConvoyNet = {
    /* cfg: { kind, url, key, clientId, keepalive, askPrefix, askFreshMs,
             onOpen, onClose, onError, onMessage, onChange } */
    create(cfg) {
      return cfg.kind === 'supabase' ? supabaseDriver(cfg) : mqttDriver(cfg);
    },
    askIdIn(topic) {
      const m = ASK.exec(String(topic || ''));
      return m ? m[1] : null;
    },
  };
})();
