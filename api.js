// طبقة البيانات: كل اتصال بـ Supabase يمر من هنا.
(() => {
  if (window.JADA_API) return;
  const cfg = window.JADA_CONFIG || {};
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !String(cfg.SUPABASE_URL).startsWith('YOUR_') && window.supabase && window.supabase.createClient);
  if (!configured) { window.JADA_API = { configured: false }; return; }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const ok = ({ data, error }) => { if (error) throw error; return data; };

  window.JADA_API = {
    configured: true,

    // للجميع
    publicState: async () => ok(await sb.rpc('public_state')),
    eventResults: async (id) => ok(await sb.rpc('event_results', { p_event_id: id })),

    // للمحكّمين
    judgeSession: async (code) => ok(await sb.rpc('judge_session', { p_code: code })),
    submitScore: async (code, teamId, vals, worthy, note) =>
      ok(await sb.rpc('submit_score', { p_code: code, p_team_id: teamId, p_vals: vals, p_worthy: worthy, p_note: note || '' })),

    // للمنظّمين
    getUser: async () => { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
    onAuth: (fn) => sb.auth.onAuthStateChange((_e, session) => fn(session ? session.user : null)),
    signIn: async (email, password) => ok(await sb.auth.signInWithPassword({ email, password })),
    signOut: async () => { await sb.auth.signOut(); },
    isAdmin: async () => !!ok(await sb.rpc('is_admin')),
    listEvents: async () => ok(await sb.from('events').select('*').order('created_at', { ascending: false })),
    getCurrent: async () => { const d = ok(await sb.from('settings').select('current_event').eq('id', 1).maybeSingle()); return d ? d.current_event : null; },
    setCurrent: async (id) => ok(await sb.from('settings').update({ current_event: id }).eq('id', 1)),
    listJudges: async (eventId) => ok(await sb.from('judges').select('id,name,code,position').eq('event_id', eventId).order('position')),
    createEvent: async (row) => ok(await sb.from('events').insert(row).select().single()),
    updateEvent: async (id, row) => ok(await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id)),
    syncJudges: async (eventId, judges, removedIds) => {
      if (removedIds.length) ok(await sb.from('judges').delete().in('id', removedIds));
      const existing = judges.filter((j) => j.id);
      for (const j of existing) ok(await sb.from('judges').update({ name: j.name, position: j.position }).eq('id', j.id));
      const fresh = judges.filter((j) => !j.id).map((j) => ({ event_id: eventId, name: j.name, position: j.position }));
      if (fresh.length) ok(await sb.from('judges').insert(fresh));
    },
    rawScores: async (eventId) => ok(await sb.from('scores').select('judge_name,team_id,vals,worthy,note,updated_at').eq('event_id', eventId).order('judge_name'))
  };
})();
