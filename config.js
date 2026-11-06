// Supabase project: proview-employee (London)
// The publishable key is designed to be public — the privacy rules in
// supabase/schema.sql decide who can read and change what.
//
// Rollout switch: while ONLINE_FOR_EVERYONE is false, the online version only
// runs on devices that opened the site once with ?online=1 (and ?online=0 turns
// it off again on that device). Set it to true to switch everyone over.
(function () {
  var ONLINE_FOR_EVERYONE = false;
  var q = location.search, on = false;
  try {
    if (/[?&]online=1\b/.test(q)) localStorage.setItem('pe-online', '1');
    if (/[?&]online=0\b/.test(q)) localStorage.removeItem('pe-online');
    on = ONLINE_FOR_EVERYONE || localStorage.getItem('pe-online') === '1';
  } catch (e) { on = ONLINE_FOR_EVERYONE; }
  if (!on) return;
  window.PE_CONFIG = {
    SUPABASE_URL: 'https://xcuxrcvebbtmhttruulz.supabase.co',
    SUPABASE_KEY: 'sb_publishable_x7xszsotrKPH6c9wCAfa6w_3Ixa5S8o',
  };
})();
