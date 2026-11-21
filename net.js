/* The transport. Supabase, and nothing else.
 *
 * The public MQTT relays are gone. They were four strangers' servers, they flapped, they
 * could not hold anything, and they could not tell one phone from another — which is why
 * there is now an account instead of a device id and a retained topic.
 *
 * The app above this line still publishes a topic and gets messages back, so the rest of
 * the code did not have to change when the relay went.
 */
(function () {
  'use strict';

  const ASK = /\/ask\/([^/]+)$/;

  function supabaseDriver(cfg) {
    let sb = null;
    let channel = null;
    let uid = null;
    let userEmail = '';
    let live = false;
    let stopped = false;

    const bodyOf = (b) => (typeof b === 'string' ? b : (b == null ? '' : String(b)));

    async function loadAsks() {
      // Requests waiting to be answered. They are rows, not a retained message, so they
      // outlive whoever sent them and are found by an admin whenever they open the app.
      try {
        const { data } = await sb.from('asks').select('id, body, at')
          .gte('at', new Date(Date.now() - cfg.askFreshMs).toISOString());
        (data || []).forEach((row) => {
          cfg.onMessage(cfg.askPrefix + row.id, { toString: () => row.body || '' });
        });
      } catch (e) { /* the bus still works without them */ }
    }

    return {
      kind: 'supabase',
      get connected() { return live; },
      client() { return sb; },
      uid() { return uid; },
      session() { return { id: uid, email: (userEmail || '') }; },

      async start() {
        if (typeof supabase === 'undefined' || !supabase.createClient) {
          cfg.onError(new Error('could not load the Supabase library'));
          return;
        }
        try {
          sb = supabase.createClient(cfg.url, cfg.key, {
            auth: { persistSession: true, autoRefreshToken: true },
          });
          const { data } = await sb.auth.getSession();
          const session = data && data.session;
          if (!session || !session.user) {
            /* No account on this phone yet. There is nothing to connect to until there is:
               membership is a row keyed by the account, so an anonymous connection would
               have no identity to be a member with. */
            cfg.onNeedsAuth();
            return;
          }
          uid = session.user.id;
          userEmail = session.user.email || '';
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

        /* A request arriving while this phone is open has to be seen straight away. On the
           relays the broker pushed the retained topic; here the row appears, and without
           this only a phone that connected afterwards would ever notice it. */
        channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'asks' },
          (row) => {
            const next = row && row.new;
            if (!next || !next.id) return;
            cfg.onMessage(cfg.askPrefix + next.id,
              { toString: () => next.body || '' });
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
        sb.publishes = sb.publishes || [];
        sb.publishes.push({ topic, msg: text, opts: opts || {} });

        const ask = ASK.exec(topic);
        if (ask) {
          // Retained: an empty body is a withdrawal.
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
        /* Broadcast arrives for everything on the channel, so there is nothing to send the
           server. The topics are recorded because "what is this app listening to" is worth
           being able to answer. */
        if (topic && sb && Array.isArray(sb.subscriptions) && sb.subscriptions.indexOf(topic) < 0) {
          sb.subscriptions.push(topic);
        }
      },

      unsubscribe() { /* one channel carries everything */ },

      /* A phone that signs in as an admin while it is already connected has never been shown
         the requests sitting in the table, because they are read when the channel opens. */
      refreshAsks() { loadAsks(); },

      end() {
        stopped = true;
        live = false;
        try { if (sb) sb.removeChannel(channel); } catch (e) { /* ignore */ }
        channel = null;
      },
    };
  }

  window.ConvoyNet = {
    /* cfg: { url, key, clientId, askPrefix, askFreshMs,
             onOpen, onClose, onError, onMessage, onChange, onNeedsAuth } */
    create(cfg) { return supabaseDriver(cfg); },
    askIdIn(topic) {
      const m = ASK.exec(String(topic || ''));
      return m ? m[1] : null;
    },
  };
})();
